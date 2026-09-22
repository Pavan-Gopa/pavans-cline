// xai-oauth — experimental Cline provider stub (Tier 0).
//
// Reserves the `xai-oauth` provider id in the contribution registry and
// documents the upstream seam. It deliberately does NOT route requests: real
// handler + OAuth callback + settings UI live in the upstream `cline/cline`
// PR (see SPEC.md). Shipping a half-handler here would split the auth surface.

import type { AgentPlugin } from "@cline/core";
import type { AgentExtensionApi } from "@cline/shared";

const plugin: AgentPlugin = {
  name: "xai-oauth",
  manifest: {
    capabilities: ["providers"],
    providerIds: ["xai-oauth"],
  },
  setup(api: AgentExtensionApi) {
    api.registerProvider({
      name: "xai-oauth",
      description:
        "xAI Grok via SuperGrok / X Premium subscription (OAuth, experimental). " +
        "Full login + request routing ships with the upstream Cline PR; " +
        "meanwhile use providers/xai-oauth/loopback-proxy.mjs with an openai-compatible entry. See SPEC.md.",
      metadata: {
        experimental: true,
        auth: "oauth-device-code",
        docs: "providers/xai-oauth/SPEC.md",
      },
    });
  },
};

export default plugin;
