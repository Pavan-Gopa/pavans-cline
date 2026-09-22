// [+pavan] xAI Grok device-code OAuth (RFC 8628) — core auth module.
//
// Mirrors sdk/packages/core/src/auth/codex.ts structure (login + refresh +
// getValid entry points, same OAuthCredentials shape, same telemetry hooks)
// but speaks the xAI device flow from .pavan/proxies/xai-oauth/SPEC.md:
// device-code request → onAuth(url+code) → poll (authorization_pending /
// slow_down) → bearer + rotating refresh. No browser callback server —
// the user confirms on accounts.x.ai / x.ai; polling is the wait.
//
// Wiring: provider-auth-registry.ts createOAuthHandler({ providerId:
// "xai-oauth", login: loginXaiOauth, refresh: getValidXaiCredentials }).
// [+pavan:1] — everything else lives here.

import { type ITelemetryService } from "@cline/shared";
import { nanoid } from "nanoid";
import {
  captureAuthFailed,
  captureAuthRefreshSoftFailure,
  captureAuthStarted,
  captureAuthSucceeded,
  identifyAccount,
} from "../services/telemetry/core-events";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";
import { isCredentialLikelyExpired } from "./utils";
import {
  formatXAIErrorDetail,
  validateXAIEndpoint,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DEVICE_CODE_URL,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_SCOPE,
  xaiBackoffMs,
  xaiEffectiveExpiry,
} from "@cline/llms";

export const XAI_OAUTH_CONFIG = {
  discoveryUrl: XAI_OAUTH_DISCOVERY_URL,
  deviceCodeUrl: XAI_OAUTH_DEVICE_CODE_URL,
  clientId: XAI_OAUTH_CLIENT_ID,
  scope: XAI_OAUTH_SCOPE,
  refreshBufferMs: 5 * 60 * 1000,
  retryableTokenGraceMs: 30 * 1000,
  httpTimeoutMs: 30 * 1000,
} as const;

export class XaiOAuthTokenError extends Error {
  public readonly status?: number;
  public readonly errorCode?: string;

  constructor(message: string, opts?: { status?: number; errorCode?: string }) {
    super(message);
    this.name = "XaiOAuthTokenError";
    this.status = opts?.status;
    this.errorCode = opts?.errorCode;
  }

  public isLikelyInvalidGrant(): boolean {
    if (this.errorCode && /invalid_grant/i.test(this.errorCode)) return true;
    if (this.status === 400 || this.status === 401 || this.status === 403) {
      return /invalid_grant|revoked|expired|invalid refresh/i.test(this.message);
    }
    return false;
  }
}

type XaiDeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

async function discoverTokenEndpoint(requestTimeoutMs: number): Promise<string> {
  const response = await fetch(XAI_OAUTH_CONFIG.discoveryUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    throw new XaiOAuthTokenError(`xAI OIDC discovery failed: ${response.status}`, {
      status: response.status,
    });
  }
  const payload = (await response.json()) as { token_endpoint?: string };
  if (!payload.token_endpoint) throw new XaiOAuthTokenError("xAI discovery missing token_endpoint");
  return validateXAIEndpoint(payload.token_endpoint, "token_endpoint");
}

async function requestDeviceCode(requestTimeoutMs: number): Promise<XaiDeviceCode> {
  const response = await fetch(XAI_OAUTH_CONFIG.deviceCodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: XAI_OAUTH_CONFIG.clientId, scope: XAI_OAUTH_CONFIG.scope }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    const detail = formatXAIErrorDetail(await response.text(), response.status);
    throw new XaiOAuthTokenError(`xAI device-code request failed: ${detail}`, { status: response.status });
  }
  const payload = (await response.json()) as Partial<XaiDeviceCode>;
  if (
    !payload.device_code ||
    !payload.user_code ||
    !payload.verification_uri ||
    !payload.verification_uri_complete ||
    typeof payload.expires_in !== "number" ||
    typeof payload.interval !== "number"
  ) {
    throw new XaiOAuthTokenError("xAI device-code response missing required fields");
  }
  validateXAIEndpoint(payload.verification_uri, "verification_uri");
  validateXAIEndpoint(payload.verification_uri_complete, "verification_uri_complete");
  return payload as XaiDeviceCode;
}

type DevicePollResult =
  | { status: "complete"; credentials: OAuthCredentials }
  | { status: "pending" }
  | { status: "slow_down" };

function toCredentials(payload: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}): OAuthCredentials {
  if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
    throw new XaiOAuthTokenError("xAI token response missing access/refresh/expiry");
  }
  return {
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: xaiEffectiveExpiry(payload.expires_in),
  };
}

async function pollDeviceToken(
  tokenEndpoint: string,
  deviceCode: string,
  requestTimeoutMs: number,
): Promise<DevicePollResult> {
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: XAI_OAUTH_CONFIG.clientId,
      device_code: deviceCode,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    error_description?: string;
  } & Record<string, unknown>;
  if (response.ok) {
    return {
      status: "complete",
      credentials: toCredentials(payload as { access_token?: string; refresh_token?: string; expires_in?: number }),
    };
  }
  if (payload.error === "authorization_pending") return { status: "pending" };
  if (payload.error === "slow_down") return { status: "slow_down" };
  const detail = (payload.error_description || payload.error || String(response.status)).trim();
  throw new XaiOAuthTokenError(`xAI device authorization failed: ${detail}`, {
    status: response.status,
    errorCode: payload.error,
  });
}

export async function loginXaiOauth(options: {
  onAuth: OAuthLoginCallbacks["onAuth"];
  onProgress?: OAuthLoginCallbacks["onProgress"];
  telemetry?: ITelemetryService;
}): Promise<OAuthCredentials> {
  captureAuthStarted(options.telemetry, "xai-oauth");
  const requestTimeoutMs = XAI_OAUTH_CONFIG.httpTimeoutMs;
  try {
    const tokenEndpoint = await discoverTokenEndpoint(requestTimeoutMs);
    const device = await requestDeviceCode(requestTimeoutMs);
    const flowId = nanoid(8);
    options.onAuth({
      url: device.verification_uri_complete,
      instructions: `Enter code ${device.user_code} (flow ${flowId})`,
    });
    options.onProgress?.("Waiting for xAI device authorization…");
    const deadline = Date.now() + device.expires_in * 1000;
    let intervalMs = Math.max(1000, Math.floor(device.interval * 1000));
    for (;;) {
      if (Date.now() >= deadline) throw new XaiOAuthTokenError("xAI device flow timed out");
      const result = await pollDeviceToken(tokenEndpoint, device.device_code, requestTimeoutMs);
      if (result.status === "complete") {
        captureAuthSucceeded(options.telemetry, "xai-oauth");
        identifyAccount(options.telemetry, { provider: "xai-oauth" });
        return result.credentials;
      }
      if (result.status === "slow_down") intervalMs = xaiBackoffMs(intervalMs, 1);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new XaiOAuthTokenError("xAI device flow timed out");
      await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    }
  } catch (error) {
    captureAuthFailed(options.telemetry, "xai-oauth", error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function refreshXaiToken(
  credentials: OAuthCredentials,
  options?: { requestTimeoutMs?: number },
): Promise<OAuthCredentials> {
  const requestTimeoutMs = options?.requestTimeoutMs ?? XAI_OAUTH_CONFIG.httpTimeoutMs;
  const tokenEndpoint = await discoverTokenEndpoint(requestTimeoutMs);
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CONFIG.clientId,
      refresh_token: credentials.refresh,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) {
    const detail = formatXAIErrorDetail(await response.text(), response.status);
    throw new XaiOAuthTokenError(`xAI token refresh failed: ${detail}`, { status: response.status });
  }
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  // xAI rotates refresh tokens: keep the old one when the response omits it.
  return toCredentials({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? credentials.refresh,
    expires_in: payload.expires_in,
  });
}

export async function getValidXaiCredentials(
  currentCredentials: OAuthCredentials | null,
  options?: { forceRefresh?: boolean; telemetry?: ITelemetryService },
): Promise<OAuthCredentials | null> {
  if (!currentCredentials) return null;
  const forceRefresh = options?.forceRefresh === true;
  if (!forceRefresh && !isCredentialLikelyExpired(currentCredentials, XAI_OAUTH_CONFIG.refreshBufferMs)) {
    return currentCredentials;
  }
  try {
    return await refreshXaiToken(currentCredentials);
  } catch (error) {
    if (error instanceof XaiOAuthTokenError && error.isLikelyInvalidGrant()) return null;
    captureAuthRefreshSoftFailure(options?.telemetry, "xai-oauth", {
      status: error instanceof XaiOAuthTokenError ? error.status : undefined,
      errorCode: error instanceof XaiOAuthTokenError ? error.errorCode : undefined,
      errorName: error instanceof Error ? error.name : undefined,
    });
    // Soft failure: let the caller retry with the stale bearer once.
    return currentCredentials;
  }
}
