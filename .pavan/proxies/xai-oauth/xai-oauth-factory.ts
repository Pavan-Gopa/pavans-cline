// [+pavan] xai-oauth factory — thin adapter, all protocol in xai-oauth.ts.
//
// Shape follows vendors/community.ts provider modules:
// createXProviderModule(config) → { operations: { language: (modelId) => provider } }.
// OAuth device flow + token vault wiring lands here incrementally;
// v1 delegates transport to the OpenAI-compatible base with the
// subscription bearer + proxy routing from ./xai-oauth.

import {
  XAI_PUBLIC_BASE_URL,
  xaiBaseFor,
  XAI_SUBSCRIPTION_PROXY_BASE_URL,
} from "./xai-oauth";

export const XAI_OAUTH_PROVIDER_ID = "xai-oauth";

export interface XaiOauthFactoryConfig {
  baseUrl?: string;
  accessToken?: string;
  headers?: Record<string, string>;
}

/** Resolve request base: proxy-only models bypass baseUrl override. */
export function resolveXaiBase(modelId: string, configured?: string): string {
  if (configured && configured !== XAI_PUBLIC_BASE_URL && configured !== XAI_SUBSCRIPTION_PROXY_BASE_URL) {
    return configured;
  }
  return xaiBaseFor(modelId);
}

export function xaiProxyHeaders(modelId: string): Record<string, string> {
  if (xaiBaseFor(modelId) !== XAI_SUBSCRIPTION_PROXY_BASE_URL) return {};
  return {
    "x-grok-client-version": process.env.PI_XAI_CLIENT_VERSION ?? "0.2.101",
    "x-grok-client-surface": "grok-build",
    "x-grok-client-mode": "grok-shell",
  };
}

// Placeholder factory — full GatewayProviderFactory wiring follows the
// community.ts module shape once the OAuth vault lands in core.
export async function createXaiOauthProvider(_config: XaiOauthFactoryConfig = {}): Promise<unknown> {
  return { providerId: XAI_OAUTH_PROVIDER_ID, bases: [XAI_PUBLIC_BASE_URL, XAI_SUBSCRIPTION_PROXY_BASE_URL] };
}
