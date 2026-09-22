// [+pavan] xAI OAuth protocol constants — single source of truth.
//
// Lives in llms/src (bundler-visible). .pavan keeps SPEC.md (docs) +
// loopback-proxy.mjs (dev smoke). Device flow: core/src/auth/xai.ts.
// Transport: llms/src/providers/vendors/xai-oauth.ts.

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_PUBLIC_BASE_URL = "https://api.x.ai/v1";
export const XAI_SUBSCRIPTION_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";

/** Models only served by the subscription proxy (absent from api.x.ai). */
export const XAI_PROXY_ONLY_PREFIXES = ["grok-composer-"];

export function xaiRouteFor(modelId: string): "proxy" | "public" {
  return XAI_PROXY_ONLY_PREFIXES.some((p) => modelId.startsWith(p)) ? "proxy" : "public";
}

export function xaiBaseFor(modelId: string): string {
  return xaiRouteFor(modelId) === "proxy" ? XAI_SUBSCRIPTION_PROXY_BASE_URL : XAI_PUBLIC_BASE_URL;
}

// Refresh discipline (mirrors SPEC.md): 5-min skew, 30s floor, rotation.
export const XAI_ACCESS_SKEW_MS = 5 * 60 * 1000;
export const XAI_MIN_TTL_MS = 30 * 1000;

export function xaiEffectiveExpiry(expiresInS: number, now = Date.now()): number {
  return Math.max(now + XAI_MIN_TTL_MS, now + expiresInS * 1000 - XAI_ACCESS_SKEW_MS);
}

// Slow-down discipline (RFC 8628): +5s per slow_down, 1s floor.
export function xaiBackoffMs(currentMs: number, slowDowns: number): number {
  let interval = Math.max(1000, currentMs);
  for (let i = 0; i < slowDowns; i += 1) interval = Math.max(1000, interval + 5000);
  return interval;
}

// Endpoint guard: OIDC endpoints must be https + x.ai/*.x.ai.
// (The grok.com proxy is an API base, never an OIDC endpoint.)
export function validateXAIEndpoint(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Invalid xAI ${field}: ${url}`);
  const host = parsed.hostname.toLowerCase();
  if (!host || (host !== "x.ai" && !host.endsWith(".x.ai"))) throw new Error(`Invalid xAI ${field}: ${url}`);
  return url;
}

// Error hygiene: error_description only, 200 chars, never raw bodies.
export function formatXAIErrorDetail(body: string, status: number): string {
  const trimmed = body.trim();
  if (!trimmed) return String(status);
  try {
    const payload = JSON.parse(trimmed) as unknown;
    if (payload && typeof payload === "object") {
      const rec = payload as Record<string, unknown>;
      const detail =
        (typeof rec.error_description === "string" && rec.error_description.trim()) ||
        (typeof rec.error === "string" && rec.error.trim()) ||
        "";
      if (detail) return detail.length > 200 ? detail.slice(0, 200) + "…" : detail;
    }
  } catch {
    // fall through to truncated raw
  }
  return trimmed.length > 200 ? `${status} ${trimmed.slice(0, 200)}…` : `${status} ${trimmed}`;
}
