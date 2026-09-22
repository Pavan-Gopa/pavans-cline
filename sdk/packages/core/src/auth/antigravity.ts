// [+pavan] Antigravity token reader — local login reuse, no new OAuth.
//
// Reads the existing jetski token file (written by Antigravity sign-in).
// Refresh uses the standard Google OAuth endpoint with the recovered
// client id; when Google demands client_secret (unrecoverable locally),
// refresh throws an actionable error: re-sign in to Antigravity.
// Bearer vault shape mirrors openai-codex/xai-oauth (tokenSource oauth).
//
// Status: reader + refresh + getValid verified by contract test with
// mocked fetch. LIVE chat waits on a fresh user login (stored token
// expired 2026-09-08) — then this module flows without code changes.

import { type ITelemetryService } from "@cline/shared";
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
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLOUDCODE_BASE,
} from "../../../llms/src/providers/antigravity-protocol";

export const ANTIGRAVITY_OAUTH_CONFIG = {
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  clientId: ANTIGRAVITY_CLIENT_ID,
  cloudcodeBase: ANTIGRAVITY_CLOUDCODE_BASE,
  refreshBufferMs: 5 * 60 * 1000,
  httpTimeoutMs: 30 * 1000,
} as const;

export class AntigravityTokenError extends Error {
  public readonly status?: number;
  public readonly errorCode?: string;

  constructor(message: string, opts?: { status?: number; errorCode?: string }) {
    super(message);
    this.name = "AntigravityTokenError";
    this.status = opts?.status;
    this.errorCode = opts?.errorCode;
  }

  public isLikelyInvalidGrant(): boolean {
    if (this.errorCode && /invalid_grant|invalid_client/i.test(this.errorCode)) return true;
    if (this.status === 400 || this.status === 401 || this.status === 403) {
      return /invalid_grant|revoked|expired|invalid/i.test(this.message);
    }
    return false;
  }
}

export interface AntigravityStoredToken {
  access_token?: string;
  refresh_token?: string;
  expiry?: string;
  token_type?: string;
}

export function toCredentials(token: AntigravityStoredToken, fallbackRefresh?: string): OAuthCredentials {
  if (!token.access_token) throw new AntigravityTokenError("jetski token has no access_token");
  const refresh = token.refresh_token || fallbackRefresh;
  if (!refresh) throw new AntigravityTokenError("jetski token has no refresh_token");
  const expires = token.expiry ? Date.parse(token.expiry) : NaN;
  return {
    access: token.access_token,
    refresh,
    expires: Number.isFinite(expires) ? expires : Date.now() - 1,
  };
}

export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
  options?: { requestTimeoutMs?: number },
): Promise<OAuthCredentials> {
  const requestTimeoutMs = options?.requestTimeoutMs ?? ANTIGRAVITY_OAUTH_CONFIG.httpTimeoutMs;
  const response = await fetch(ANTIGRAVITY_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ANTIGRAVITY_OAUTH_CONFIG.clientId,
      refresh_token: credentials.refresh,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    const detail = (payload.error_description || payload.error || String(response.status)).slice(0, 200);
    throw new AntigravityTokenError(`Antigravity refresh failed: ${detail}`, {
      status: response.status,
      errorCode: payload.error,
    });
  }
  if (!payload.access_token) throw new AntigravityTokenError("Antigravity refresh missing access_token");
  return {
    access: payload.access_token,
    refresh: payload.refresh_token ?? credentials.refresh,
    expires: Date.now() + (typeof payload.expires_in === "number" ? payload.expires_in : 3600) * 1000,
  };
}

export async function getValidAntigravityCredentials(
  currentCredentials: OAuthCredentials | null,
  options?: { forceRefresh?: boolean; telemetry?: ITelemetryService },
): Promise<OAuthCredentials | null> {
  if (!currentCredentials) return null;
  const forceRefresh = options?.forceRefresh === true;
  if (!forceRefresh && !isCredentialLikelyExpired(currentCredentials, ANTIGRAVITY_OAUTH_CONFIG.refreshBufferMs)) {
    return currentCredentials;
  }
  try {
    return await refreshAntigravityToken(currentCredentials);
  } catch (error) {
    if (error instanceof AntigravityTokenError && error.isLikelyInvalidGrant()) return null;
    captureAuthRefreshSoftFailure(options?.telemetry, "antigravity", {
      status: error instanceof AntigravityTokenError ? error.status : undefined,
      errorCode: error instanceof AntigravityTokenError ? error.errorCode : undefined,
      errorName: error instanceof Error ? error.name : undefined,
    });
    return currentCredentials;
  }
}

// Login = adopt the local Antigravity sign-in (no browser flow of our own).
// Reads ~/.gemini/jetski-standalone-oauth-token, validates, refreshes once
// to prove viability, stores via the standard vault.
export async function loginAntigravity(options: {
  tokenFile?: string;
  callbacks: Pick<OAuthLoginCallbacks, "onProgress">;
  telemetry?: ITelemetryService;
}): Promise<OAuthCredentials> {
  captureAuthStarted(options.telemetry, "antigravity");
  try {
    const { readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const file = options.tokenFile ?? join(homedir(), ".gemini", "jetski-standalone-oauth-token");
    const store = JSON.parse(readFileSync(file, "utf8")) as {
      token?: AntigravityStoredToken;
    } & AntigravityStoredToken;
    const token = store.token ?? store;
    const credentials = toCredentials(token);
    options.callbacks.onProgress?.("Validating Antigravity login…");
    const proven = await refreshAntigravityToken(credentials);
    captureAuthSucceeded(options.telemetry, "antigravity");
    identifyAccount(options.telemetry, { provider: "antigravity" });
    return proven;
  } catch (error) {
    captureAuthFailed(options.telemetry, "antigravity", error instanceof Error ? error.message : String(error));
    if (error instanceof AntigravityTokenError) throw error;
    throw new AntigravityTokenError(
      `No live Antigravity login found — sign in to Antigravity first (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
