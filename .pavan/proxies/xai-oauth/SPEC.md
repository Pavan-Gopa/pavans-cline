# xai-oauth — Grok subscription login for Cline (SPEC + Tier 0 skeleton)

Status: experimental. Mirrors the `openai-codex` subscription provider
(browser OAuth, short-lived access + refresh in `providers.json`), but for an
xAI SuperGrok / X Premium subscription. Unlike Codex this rides an
**unofficial** protocol (same device-code flow family as the `grok` CLI, Kilo
Code, OpenCode, `piex-dev/xai-oauth`), so the provider is a thin wrapper with
contract tests — never business logic.

## Verified protocol facts (do not re-derive from memory)

- OIDC issuer `https://auth.x.ai`, discovery
  `https://auth.x.ai/.well-known/openid-configuration` → `token_endpoint`
  (validate `https:` + host `x.ai` / `*.x.ai`).
- Device-code endpoint `https://auth.x.ai/oauth2/device/code`, public client
  `b1a00492-073a-47ea-816f-4c329264a828` (observed in `~/.grok/auth.json`
  `oidc_client_id`; same id as OMP `xai-oauth`, piex, hermes-agent).
- Scope: `openid profile email offline_access grok-cli:access api:access`.
- Poll `grant_type=urn:ietf:params:oauth:grant-type:device_code`; honor
  `authorization_pending` / `slow_down` (+5s interval bump, min 1s floor);
  refresh via `grant_type=refresh_token`. xAI rotates refresh tokens — persist
  the latest atomically; multi-process use invalidates the sibling session
  (same behavior as Kilo documents).
- Endpoints: public `https://api.x.ai/v1` + subscription proxy
  `https://cli-chat-proxy.grok.com/v1` (proxy-only models like
  `grok-composer-*` are absent from the public catalog; both run on the
  subscription quota under an OAuth bearer).
- Token storage (Cline shape, mirrors `openai-codex`):
  `providers.json → providers["xai-oauth"].settings.auth =
  { accessToken, refreshToken, expiresAt, accountId?, metadata }`,
  `tokenSource: "oauth"`. Refresh with 5-min client skew + 30s min-TTL floor.
  Never log full bodies — error detail = `error`/`error_description` only,
  length-capped (200 chars).
- UX precedent (Kilo): provider row `xAI Grok OAuth (SuperGrok / X Premium)`
  + `Headless / Remote / VPS` device-code variant; browser PKCE flow opens
  `accounts.x.ai` and listens on short-lived `127.0.0.1:56121`; `Disconnect`
  clears tokens. Headless prints code + URL for any browser device.

## What Tier 0 ships here

1. `providers/xai-oauth/index.ts` — experimental `AgentPlugin` stub that only
   calls `api.registerProvider({ name: "xai-oauth", ... })`. Real request
   routing needs the upstream `cline/cline` provider surface (handler +
   OAuth callback + settings UI in `desktop-app/webview` + sidecar token
   vault); the stub reserves the provider id and documents the seam.
2. `providers/xai-oauth/loopback-proxy.mjs` — offline-safe smoke path TODAY:
   reads the existing `~/.grok/auth.json` bearer, serves OpenAI-compatible
   `/v1/models` + `/v1/chat/completions` on `127.0.0.1:8099` by forwarding to
   the configured xAI base with the subscription bearer. Point any
   `openai-compatible` provider entry at it. No tokens on disk beyond what the
   `grok` CLI already stores; proxy never logs bodies.
3. `test/xai-oauth-smoke.mjs` — contract tests that run fully offline:
   endpoint validation, `slow_down` backoff math, skew/TTL floor, error
   truncation, fallback catalog routing, proxy `/v1/models` shape.

## Known risks (ship-blockers for a real PR)

- Consumer subscription quota as an API bearer is ToS-grey and xAI can change
  the OIDC/device-code contract without notice → thin wrapper + snapshot
  contract tests; fast follow on breakage.
- Some raw API surfaces answer `403` on consumer OAuth bearers → mandatory
  fallback to `XAI_API_KEY` (console.x.ai) with a clear error naming it.
- Browser PKCE client registration for a Cline-owned OAuth client does not
  exist yet — upstream decision (reuse grok-build client id vs register a
  Cline client) belongs to the `cline/cline` PR, not this stub.

## Upstream PR checklist (cline/cline)

- `sdk/packages/llms`: provider handler (OpenAI-compatible + bearer refresh
  with skew/floor), `registerProvider`/`configureProvider`/`listModels`
  entries, proxy routing per model (`baseUrl` + `x-grok-client-*` headers).
- Device-code login command + browser PKCE callback server (short-lived
  localhost listener), token vault writes to `providers.json`.
- `apps/examples/desktop-app/webview`: Settings → Providers → xAI rows
  (OAuth + Headless + API key), Disconnect; sidecar: no refresh-token
  exfil over the SSH tunnel (same rule as existing OAuth providers).
