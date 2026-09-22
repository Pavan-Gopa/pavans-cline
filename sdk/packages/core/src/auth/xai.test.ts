// [+pavan] xai device-flow contract: login polling, refresh rotation,
// expiry discipline. Bun-native (workspace resolves @cline/*).

import { strict as assert } from "node:assert";
import { describe, it, vi, beforeEach, afterEach } from "vitest";
import {
  getValidXaiCredentials,
  loginXaiOauth,
  refreshXaiToken,
  XAI_OAUTH_CONFIG,
  XaiOAuthTokenError,
} from "./xai.ts";

function tokenResponse(over: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: "access-1",
    refresh_token: "refresh-2",
    expires_in: 21600,
    ...over,
  });
}

function discoveryThen(handler: (url: string) => Promise<Response>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).includes("openid-configuration")) {
      return Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" });
    }
    return handler(String(url), init);
  }) as typeof fetch;
}

describe("xai device flow", () => {
  const realFetch = globalThis.fetch;
  let calls: Array<{ url: string; body: string }>;

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("refresh posts grant_type=refresh_token and applies skew/floor", async () => {
    globalThis.fetch = discoveryThen(async (url, init) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return tokenResponse();
    });
    const out = await refreshXaiToken({ access: "a", refresh: "r", expires: 0 });
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /grant_type=refresh_token/);
    assert.match(calls[0].body, new RegExp(XAI_OAUTH_CONFIG.clientId));
    assert.equal(out.access, "access-1");
    assert.equal(out.refresh, "refresh-2");
    assert.ok(out.expires > Date.now());
  });

  it("refresh keeps the old token when the response omits rotation", async () => {
    globalThis.fetch = discoveryThen(async () =>
      Response.json({ access_token: "a2", expires_in: 3600 }),
    );
    const out = await refreshXaiToken({ access: "a", refresh: "old", expires: 0 });
    assert.equal(out.refresh, "old");
  });

  it("invalid_grant refresh resolves to null (re-login), other errors soft-fail", async () => {
    globalThis.fetch = discoveryThen(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    assert.equal(await getValidXaiCredentials({ access: "a", refresh: "r", expires: 0 }), null);

    globalThis.fetch = discoveryThen(async () => {
      throw new Error("socket down");
    });
    const stale = { access: "a", refresh: "r", expires: 0 };
    assert.equal(await getValidXaiCredentials(stale), stale);
  });

  it("fresh credentials pass through untouched", async () => {
    const fresh = { access: "a", refresh: "r", expires: Date.now() + 3600_000 };
    assert.equal(await getValidXaiCredentials(fresh), fresh);
    assert.equal(calls.length, 0);
  });

  it("device login polls pending then completes", async () => {
    let n = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("openid-configuration")) {
        return Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" });
      }
      if (String(url).includes("device/code")) {
        return Response.json({
          device_code: "d",
          user_code: "ABCD-1234",
          verification_uri: "https://accounts.x.ai/verify",
          verification_uri_complete: "https://accounts.x.ai/verify?code=ABCD-1234",
          expires_in: 600,
          interval: 0,
        });
      }
      n += 1;
      if (n < 3) return Response.json({ error: "authorization_pending" }, { status: 400 });
      return tokenResponse();
    }) as typeof fetch;
    const seen: string[] = [];
    const creds = await loginXaiOauth({
      onAuth: (info) => seen.push(info.url),
      onProgress: () => {},
    });
    assert.equal(creds.access, "access-1");
    assert.ok(seen[0].includes("accounts.x.ai"));
  });

  it("device login rejects foreign verification endpoints", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("openid-configuration")) {
        return Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" });
      }
      return Response.json({
        device_code: "d",
        user_code: "X",
        verification_uri: "https://evil.com/verify",
        verification_uri_complete: "https://evil.com/verify?x=1",
        expires_in: 600,
        interval: 0,
      });
    }) as typeof fetch;
    await assert.rejects(() => loginXaiOauth({ onAuth: () => {} }), /Invalid xAI/);
  });

  it("token error classifies invalid_grant", () => {
    assert.equal(new XaiOAuthTokenError("x", { errorCode: "invalid_grant" }).isLikelyInvalidGrant(), true);
    assert.equal(new XaiOAuthTokenError("revoked door", { status: 401 }).isLikelyInvalidGrant(), true);
    assert.equal(new XaiOAuthTokenError("socket down").isLikelyInvalidGrant(), false);
  });
});
