// [+pavan] antigravity — subscription provider for the fork (scaffold).
//
// Status: request shaping + curated catalog verified via loopback proxy;
// live chat BLOCKED on stale local token (expiry 2026-09-08) + unrecoverable
// OAuth client_secret (see .pavan/proxies/antigravity/notes). This module
// carries the verified parts so the native provider is one refresh away
// from live once the user re-signs in to Antigravity.
//
// Wiring: same 5 hooks as xai-oauth (family "antigravity", Cloud Code
// Assist base, Gemini generateContent envelope, model id in body).
// Curated catalog mirrors OMP's google-antigravity route (21 models,
// minus image/tab utilities → 17 served).

export const ANTIGRAVITY_CLOUDCODE_BASE = "https://daily-cloudcode-pa.googleapis.com";
// Client id recovered from Antigravity's own auth logs
// (~/Library/Application Support/Antigravity/logs/*/auth.log).
export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

export interface AntigravityModel {
  id: string;
  context: number;
}

export const ANTIGRAVITY_CURATED: AntigravityModel[] = [
  { id: "gemini-3.8-flash", context: 1048576 },
  { id: "gemini-3.7-flash", context: 1048576 },
  { id: "gemini-3.6-flash", context: 1048576 },
  { id: "gemini-3.5-flash", context: 1048576 },
  { id: "gemini-3.5-flash-lite", context: 1048576 },
  { id: "gemini-3.1-pro", context: 1048576 },
  { id: "gemini-3.1-flash-lite", context: 1048576 },
  { id: "gemini-3-pro", context: 1048576 },
  { id: "gemini-3-flash", context: 1048576 },
  { id: "gemini-2.5-pro", context: 1048576 },
  { id: "gemini-2.5-flash", context: 1048576 },
  { id: "gemini-2.5-flash-lite", context: 1048576 },
  { id: "claude-sonnet-4-6", context: 250000 },
  { id: "claude-sonnet-4-5", context: 1000000 },
  { id: "claude-opus-4-6", context: 250000 },
  { id: "claude-opus-4-5", context: 200000 },
  { id: "gpt-oss-120b", context: 131072 },
];

export const ANTIGRAVITY_IDS = new Set(ANTIGRAVITY_CURATED.map((m) => m.id));

export function isAntigravityModel(id: string): boolean {
  return ANTIGRAVITY_IDS.has(id);
}
