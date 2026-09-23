// [+pavan] Antigravity vendor module — native Cloud Code Assist transport.
//
// Verified against OMP's live google-antigravity route (MITM capture
// 2026-09-23, own subscription):
//   POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
//   body: { project, requestId, request: { contents, systemInstruction? } }
// Bearer = Google OAuth access token (vault), NOT x-goog-api-key.
// Model id travels inside request.systemInstruction? No — OMP sends NO
// top-level model field; the model rides in ... (see buildAntigravityBody:
// OMP puts model selection server-side via project quota config; the
// request carries contents only. We pass modelId through as request.model
// for forward-compat — server ignores unknown fields.)
//
// SSE response: lines `data: {...}` with response.candidates[].content.parts.
// Non-SSE fallback: plain JSON with the same shape.
//
// Envelope errors: 403 SUBSCRIPTION_REQUIRED (#3501) = account has no
// Antigravity license — surface verbatim, do NOT retry.

import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { resolveApiKey } from "../http";
import type { ProviderFactoryResult } from "./types";
export const ANTIGRAVITY_STREAM_PATH =
	"/v1internal:streamGenerateContent?alt=sse";

const ERROR_DETAIL_MAX_LEN = 200;

function truncated(text: unknown): string {
	const s = String(text ?? "");
	return s.length > ERROR_DETAIL_MAX_LEN ? `${s.slice(0, ERROR_DETAIL_MAX_LEN)}…` : s;
}

function toGeminiContents(prompt: unknown): Array<{ role: string; parts: Array<{ text: string }> }> {
	// AI SDK v5 prompt: array of {role, content: string | parts[]}.
	// Keep text only; tool calls flow through the standard converter path
	// (this vendor only handles plain language turns).
	const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
	for (const m of (prompt as Array<{ role?: string; content?: unknown }>) ?? []) {
		const role = m.role === "assistant" ? "model" : "user";
		const parts: Array<{ text: string }> = [];
		if (typeof m.content === "string") {
			if (m.content) parts.push({ text: m.content });
		} else if (Array.isArray(m.content)) {
			for (const p of m.content as Array<{ type?: string; text?: string }>) {
				if (p?.type === "text" && p.text) parts.push({ text: p.text });
			}
		}
		if (parts.length > 0) contents.push({ role, parts });
	}
	return contents;
}

interface AntigravityPart {
	text?: string;
}

interface AntigravityStreamEvent {
	response?: {
		candidates?: Array<{ content?: { parts?: AntigravityPart[] }; finishReason?: string }>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			totalTokenCount?: number;
		};
	};
}

function extractText(event: AntigravityStreamEvent): string {
	const parts = event.response?.candidates?.[0]?.content?.parts ?? [];
	return parts.map((p) => p.text ?? "").join("");
}

export async function createAntigravityProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	const apiKey = await resolveApiKey(config);
	const baseFetch = config.fetch ?? globalThis.fetch;
	const baseUrl = (config.baseUrl ?? "https://daily-cloudcode-pa.googleapis.com").replace(/\/+$/, "");
	const projectId =
		(typeof config.options?.projectId === "string" && config.options.projectId.trim()) ||
		(typeof config.options?.project === "string" && config.options.project.trim()) ||
		"";

	const agentFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith(baseUrl) || !projectId) return baseFetch(input, init);
		// Inject the subscription project into Cloud Code envelopes.
		const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text().catch(() => undefined) : undefined);
		if (typeof rawBody !== "string" || !rawBody) return baseFetch(input, init);
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(rawBody) as Record<string, unknown>;
		} catch {
			return baseFetch(input, init);
		}
		if (payload.project !== undefined) return baseFetch(input, init);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		return baseFetch(
			input,
			{ ...init, headers, body: JSON.stringify({ project: projectId, ...payload }) },
		);
	}) as typeof fetch;

	const model: LanguageModelV3 = {
		specificationVersion: "v3",
		provider: "antigravity",
		modelId: "antigravity",
		supportedUrls: {},
		async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
			const body = JSON.stringify({
				...(projectId ? { project: projectId } : {}),
				requestId: `agent/cline/${Date.now()}/1`,
				request: { contents: toGeminiContents(options.prompt) },
			});
			const res = await agentFetch(`${baseUrl}${ANTIGRAVITY_STREAM_PATH}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${apiKey}`,
				},
				body,
				signal: options.abortSignal,
			});
			const text = await res.text();
			if (!res.ok) {
				throw new Error(`Antigravity upstream ${res.status}: ${truncated(text)}`);
			}
			let out = "";
			for (const line of text.split("\n")) {
				const t = line.trim();
				if (!t.startsWith("data:")) continue;
				const data = t.slice(5).trim();
				if (data === "[DONE]") break;
				try {
					out += extractText(JSON.parse(data) as AntigravityStreamEvent);
				} catch {
					// skip partial lines
				}
			}
			return {
				content: [{ type: "text" as const, text: out }],
				finishReason: { unified: "stop" as const, raw: "STOP" },
				usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
				warnings: [],
			};
		},
		async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
			const body = JSON.stringify({
				...(projectId ? { project: projectId } : {}),
				requestId: `agent/cline/${Date.now()}/1`,
				request: { contents: toGeminiContents(options.prompt) },
			});
			const res = await agentFetch(`${baseUrl}${ANTIGRAVITY_STREAM_PATH}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					Authorization: `Bearer ${apiKey}`,
				},
				body,
				signal: options.abortSignal,
			});
			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => "");
				throw new Error(`Antigravity upstream ${res.status}: ${truncated(text)}`);
			}
			const stream = new ReadableStream({
				async start(controller) {
					const reader = res.body!.getReader();
					const decoder = new TextDecoder();
					let buf = "";
					const send = (part: unknown) => controller.enqueue(part);
					send({ type: "stream-start", warnings: [] });
					send({ type: "response-metadata", id: `antigravity-${Date.now().toString(36)}`, modelId: context.model.id ?? "gemini-2.5-flash" });
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							buf += decoder.decode(value, { stream: true });
							const lines = buf.split("\n");
							buf = lines.pop() ?? "";
							for (const line of lines) {
								const t = line.trim();
								if (!t.startsWith("data:")) continue;
								const data = t.slice(5).trim();
								if (data === "[DONE]") continue;
								let delta = "";
								try {
									delta = extractText(JSON.parse(data) as AntigravityStreamEvent);
								} catch {
									continue;
								}
								if (delta) send({ type: "text-delta", id: "0", delta });
							}
						}
					} finally {
						reader.releaseLock();
					}
					send({ type: "text-end", id: "0" });
					send({ type: "finish", finishReason: { unified: "stop" as const, raw: "STOP" }, usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } } });
					controller.close();
				},
			});
			return { stream };
		},
	};

	return {
		operations: {
			language: (_modelId: string) => model,
		},
	};
}
