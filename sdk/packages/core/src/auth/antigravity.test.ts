// [+pavan] antigravity token contract: reader, refresh, expiry, vault errors.
// Bun-native. Live network never touched — refresh endpoint mocked.

import { strict as assert } from "node:assert";
import { describe, it, vi, afterEach } from "vitest";
import {
  AntigravityTokenError,
  getValidAntigravityCredentials,
  refreshAntigravityToken,
  toCredentials,
} from "./antigravity.ts";

describe("antigravity tokens", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("toCredentials parses the jetski shape", () => {
    const c = toCredentials({ access_token: "ya29.x", refresh_token: "1//y", expiry: "2026-09-08T13:42:53.558345+05:30" });
    assert.equal(c.access, "ya29.x");
    assert.equal(c.refresh, "1//y");
    assert.ok(c.expires > 0);
  });

  it("toCredentials rejects token without bearer", () => {
    assert.throws(() => toCredentials({ refresh_token: "r" }), /no access_token/);
  });

  it("refresh posts to Google OAuth and rotates", async () => {
    let seen = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = String(init?.body ?? "");
      return Response.json({ access_token: "new-a", refresh_token: "new-r", expires_in: 3600 });
    }) as typeof fetch;
    const out = await refreshAntigravityToken({ access: "old", refresh: "r", expires: 0 });
    assert.match(seen, /grant_type=refresh_token/);
    assert.equal(out.access, "new-a");
    assert.equal(out.refresh, "new-r");
    assert.ok(out.expires > Date.now());
  });

  it("invalid_grant resolves to null, transport errors soft-fail", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    assert.equal(await getValidAntigravityCredentials({ access: "a", refresh: "r", expires: 0 }), null);

    globalThis.fetch = (async () => {
      throw new Error("socket down");
    }) as typeof fetch;
    const stale = { access: "a", refresh: "r", expires: 0 };
    assert.equal(await getValidAntigravityCredentials(stale), stale);
  });

  it("fresh credentials pass through", async () => {
    const fresh = { access: "a", refresh: "r", expires: Date.now() + 3600_000 };
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("must not fetch");
    }) as typeof fetch;
    assert.equal(await getValidAntigravityCredentials(fresh), fresh);
    assert.equal(called, false);
  });

  it("error classifies invalid_client as re-login", () => {
    assert.equal(new AntigravityTokenError("x", { errorCode: "invalid_client" }).isLikelyInvalidGrant(), true);
    assert.equal(new AntigravityTokenError("socket down").isLikelyInvalidGrant(), false);
  });
});
