// [+pavan] antigravity factory — scaffold adapter (chat waits on fresh login).
//
// Mirrors xai-oauth-factory.ts shape. Transport = Cloud Code Assist
// generateContent envelope (see loopback-proxy.mjs, verified to /v1/models).

import { ANTIGRAVITY_CLOUDCODE_BASE, ANTIGRAVITY_CURATED } from "./antigravity";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

export function antigravityModelIds(): string[] {
  return ANTIGRAVITY_CURATED.map((m) => m.id);
}

export async function createAntigravityProvider(_config: Record<string, unknown> = {}): Promise<unknown> {
  return { providerId: ANTIGRAVITY_PROVIDER_ID, base: ANTIGRAVITY_CLOUDCODE_BASE, models: antigravityModelIds() };
}
