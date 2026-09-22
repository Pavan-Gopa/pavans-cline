#!/usr/bin/env node
// loopback-proxy.mjs — TODAY's smoke path for Grok-subscription usage in Cline.
//
// Reads the existing `~/.grok/auth.json` OAuth bearer (written by the official
// `grok` CLI login, never by this proxy) and serves an OpenAI-compatible
// surface on 127.0.0.1. Point any `openai-compatible` provider entry at it:
//
//   baseUrl: http://127.0.0.1:8099/v1   (+ any dummy apiKey)
//
// Endpoints: GET /v1/models, POST /v1/chat/completions, GET /health.
// Routing: model ids starting with grok-composer- (or GROK_PROXY_MODELS)
// go to the subscription proxy, the rest to the public API. Both carry the
// same OAuth bearer, so both run on the subscription quota.
//
// Security posture: loopback-only bind; Authorization header forwarded, never
// logged; upstream error bodies truncated to 200 chars; no token persistence.
// This is a local smoke harness, not the product provider (see SPEC.md).

import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.GROK_PROXY_PORT ?? 8099);
const PUBLIC_BASE = process.env.GROK_PUBLIC_BASE ?? "https://api.x.ai/v1";
const PROXY_BASE = process.env.GROK_PROXY_BASE ?? "https://cli-chat-proxy.grok.com/v1";
const PROXY_PREFIXES = (process.env.GROK_PROXY_MODELS ?? "grok-composer-").split(",").filter(Boolean);
const TOKEN_ENDPOINT = process.env.GROK_TOKEN_ENDPOINT ?? "https://auth.x.ai/oauth2/token";
const CLIENT_ID = process.env.GROK_CLIENT_ID ?? "b1a00492-073a-47ea-816f-4c329264a828";
const ACCESS_SKEW_MS = 5 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;

function loadCredentials() {
  const path = process.env.GROK_AUTH_JSON ?? join(homedir(), ".grok", "auth.json");
  const store = JSON.parse(readFileSync(path, "utf8"));
  const key = Object.keys(store)[0];
  const entry = store[key];
  if (!entry?.key) throw new Error(`no OAuth bearer in ${path} — run \`grok login\` first`);
  if (!entry?.refresh_token) throw new Error(`no refresh_token in ${path} — run \`grok login\` first`);
  return { access: entry.key, refresh: entry.refresh_token };
}

let creds;
try {
  creds = loadCredentials();
} catch (error) {
  console.error(`[grok-loopback] ${error.message}`);
  process.exit(1);
}

async function refreshCredentials() {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: creds.refresh }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh failed (${res.status} ${truncated(text)}): re-run \`grok login\``);
  }
  const payload = await res.json();
  if (!payload.access_token || !payload.refresh_token) throw new Error("refresh response missing tokens");
  creds = {
    access: payload.access_token,
    refresh: payload.refresh_token,
    // Rotation: xAI rotates the refresh token on each use. The grok CLI owns
    // persistence of ~/.grok/auth.json; this proxy keeps the latest in memory.
    expiresAt: Date.now() + Number(payload.expires_in ?? 21600) * 1000 - ACCESS_SKEW_MS,
  };
  if (creds.expiresAt < Date.now() + MIN_TTL_MS) creds.expiresAt = Date.now() + MIN_TTL_MS;
}

function baseFor(model) {
  if (typeof model === "string" && PROXY_PREFIXES.some((p) => model.startsWith(p))) return PROXY_BASE;
  return PUBLIC_BASE;
}

function truncated(text) {
  const s = String(text ?? "");
  return s.length > ERROR_DETAIL_MAX_LEN ? s.slice(0, ERROR_DETAIL_MAX_LEN) + "…" : s;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function forward(path, init, retried = false) {
  const upstream = await fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${creds.access}` },
    signal: AbortSignal.timeout(120000),
  });
  if ((upstream.status === 401 || upstream.status === 403) && !retried) {
    // Bearer may have expired since CLI login: one refresh, then replay once.
    await refreshCredentials();
    return forward(path, init, true);
  }
  return upstream;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, public: PUBLIC_BASE, proxy: PROXY_BASE }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const [pub, prx] = await Promise.all([
        forward(`${PUBLIC_BASE}/models`, { method: "GET", headers: { Accept: "application/json" } }),
        forward(`${PROXY_BASE}/models`, { method: "GET", headers: { Accept: "application/json" } }),
      ]);
      const data = { object: "list", data: [] };
      for (const [resp, base] of [[pub, PUBLIC_BASE], [prx, PROXY_BASE]]) {
        if (!resp.ok) continue;
        const payload = await resp.json().catch(() => null);
        const list = Array.isArray(payload?.data) ? payload.data : [];
        for (const m of list) {
          if (m?.id && !data.data.some((e) => e.id === m.id)) {
            data.data.push({ id: m.id, object: "model", owned_by: base.includes("proxy") ? "xai-subscription-proxy" : "xai-subscription", created: m.created ?? 0 });
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
      const base = baseFor(payload.model);
      const headers = { "Content-Type": "application/json", Accept: "application/json" };
      if (base === PROXY_BASE) {
        headers["x-grok-client-version"] = process.env.PI_XAI_CLIENT_VERSION ?? "0.2.101";
        headers["x-grok-client-surface"] = "grok-build";
        headers["x-grok-client-mode"] = "grok-shell";
      }
      const upstream = await forward(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const text = await upstream.text();
      if (!upstream.ok && (upstream.status === 401 || upstream.status === 403)) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: `xAI rejected the subscription bearer (${upstream.status} ${truncated(text)}). Re-run \`grok login\`, or fall back to XAI_API_KEY.`,
          }),
        );
        return;
      }
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(text);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: truncated(error instanceof Error ? error.message : String(error)) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[grok-loopback] http://127.0.0.1:${PORT}/v1 (public=${PUBLIC_BASE} proxy=${PROXY_BASE})`);
});
