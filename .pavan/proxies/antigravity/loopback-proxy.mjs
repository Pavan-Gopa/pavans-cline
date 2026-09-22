#!/usr/bin/env node
// loopback-proxy.mjs — Antigravity subscription models as OpenAI-compatible.
//
// STATUS: scaffold verified to /v1/models + request shaping; live chat NOT
// yet verified — the local jetski token (expiry 2026-09-08) is stale and the
// OAuth client_secret for refresh is not recoverable from local files.
// Re-sign in to Antigravity, then chat should flow. See BOLD TRUTH below.
//   OAuth bearer in Authorization. Request body is a Gemini generateContent
//   envelope; the model id goes in the body, not the URL.
// - Bearer refresh: Google refresh_token grant against oauth2.googleapis.com
//   with the jetski client id (from the token file's audience). One refresh +
//   one replay on 401, same discipline as the Grok proxy.
// - Only curated models are served (OMP's 21-model google-antigravity list,
//   minus image/tab utility entries): the endpoint accepts more, but the
//   curated list is what the subscription quota is meant for.
//
// Security posture: loopback-only bind; bearer forwarded, never logged;
// upstream errors truncated to 200 chars; token file only read, never written.
// ToS note: this reuses YOUR OWN subscription login locally, like the Grok
// proxy. It is still an unofficial path — Google can change or throttle it.

import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.ANTIGRAVITY_PROXY_PORT ?? 8097);
const CLOUDCODE_BASE =
  process.env.ANTIGRAVITY_BASE ?? "https://daily-cloudcode-pa.googleapis.com";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ERROR_DETAIL_MAX_LEN = 200;

// Curated subscription catalog — mirrors OMP's google-antigravity route
// (api: google-gemini-cli on Cloud Code), minus image/tab utility models.
const CURATED_MODELS = [
  { id: "gemini-3.8-flash", context: 1048576 },
  { id: "gemini-3.7-flash", context: 1048576 },
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
const CURATED_IDS = new Set(CURATED_MODELS.map((m) => m.id));

function truncated(text) {
  const s = String(text ?? "");
  return s.length > ERROR_DETAIL_MAX_LEN ? s.slice(0, ERROR_DETAIL_MAX_LEN) + "…" : s;
}

function loadCredentials() {
  const path = process.env.ANTIGRAVITY_TOKEN_FILE ?? join(homedir(), ".gemini", "jetski-standalone-oauth-token");
  const store = JSON.parse(readFileSync(path, "utf8"));
  const token = store.token ?? store;
  if (!token?.access_token) throw new Error(`no OAuth bearer in ${path} — sign in to Antigravity first`);
  if (!token?.refresh_token) throw new Error(`no refresh_token in ${path} — sign in to Antigravity first`);
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    // jetski client id observed in Antigravity's own auth logs
    // (Library/Application Support/Antigravity/logs/*/auth.log).
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  };
}

let creds;
try {
  creds = loadCredentials();
} catch (error) {
  console.error(`[antigravity-loopback] ${error.message}`);
  process.exit(1);
}

async function refreshCredentials() {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: creds.clientId,
      refresh_token: creds.refresh,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`refresh failed (${res.status} ${truncated(text)}): re-sign in to Antigravity`);
  }
  const payload = await res.json();
  if (!payload.access_token) throw new Error("refresh response missing access_token");
  creds.access = payload.access_token;
  if (payload.refresh_token) creds.refresh = payload.refresh_token;
}

async function cloudcode(path, init, retried = false) {
  const upstream = await fetch(`${CLOUDCODE_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${creds.access}` },
    signal: AbortSignal.timeout(180000),
  });
  if (upstream.status === 401 && !retried) {
    await refreshCredentials();
    return cloudcode(path, init, true);
  }
  return upstream;
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

// --- OpenAI messages → Gemini contents (text only; images pass as inlineData when possible) ---
function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages ?? []) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    const content = m.content;
    if (typeof content === "string") {
      if (content) parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "text" && part.text) parts.push({ text: part.text });
        else if (part?.type === "image_url" && part.image_url?.url) {
          const match = /^data:([^;]+);base64,(.+)$/.exec(part.image_url.url);
          if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

function toGeminiBody(payload) {
  return {
    model: payload.model,
    contents: toGeminiContents(payload.messages),
    generationConfig: {
      ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
      ...(payload.max_tokens !== undefined ? { maxOutputTokens: payload.max_tokens } : {}),
    },
  };
}

// --- Gemini response → OpenAI chat.completion (first candidate, text join) ---
function toOpenAICompletion(payload, model, gemini) {
  const candidate = gemini?.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  return {
    id: `antigravity-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: gemini?.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: gemini?.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: gemini?.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, upstream: CLOUDCODE_BASE, models: CURATED_MODELS.length }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: CURATED_MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "antigravity-subscription", context_window: m.context })),
        }),
      );
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
      if (!payload.model || !CURATED_IDS.has(payload.model)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: `unknown model "${payload.model ?? ""}" — pick an exact id from GET /v1/models (${CURATED_MODELS.length} curated)`,
          }),
        );
        return;
      }
      const upstream = await cloudcode("/v1internal:generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(toGeminiBody(payload)),
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        const code = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              upstream.status === 401 || upstream.status === 403
                ? `Antigravity rejected the bearer (${upstream.status} ${truncated(text)}). Re-sign in, or fall back to a Gemini API key.`
                : `upstream ${upstream.status}: ${truncated(text)}`,
          }),
        );
        return;
      }
      let gemini;
      try {
        gemini = JSON.parse(text);
      } catch {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "upstream returned non-JSON" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(toOpenAICompletion(payload, payload.model, gemini)));
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
  console.log(`[antigravity-loopback] http://127.0.0.1:${PORT}/v1 (${CURATED_MODELS.length} models via ${CLOUDCODE_BASE})`);
});
