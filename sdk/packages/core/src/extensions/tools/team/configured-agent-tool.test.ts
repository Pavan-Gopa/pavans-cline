import { describe, expect, it } from "vitest";
import {
	buildAgentRuntimeConfig,
	buildConfiguredAgentToolName,
	createConfiguredAgentTools,
} from "./configured-agent-tool";

describe("configured agent tools", () => {
	it("builds stable subagent tool names", () => {
		expect(buildConfiguredAgentToolName("Code Reviewer")).toBe(
			"subagent_code_reviewer",
		);
		expect(buildConfiguredAgentToolName("___")).toBe("subagent_agent");
	});

	it("matches spawn_agent timeout and retry policy", () => {
		const [tool] = createConfiguredAgentTools({
			configProvider: {
				getRuntimeConfig: () => ({
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
					apiKey: "key",
				}),
				getConnectionConfig: () => ({
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
					apiKey: "key",
				}),
				updateConnectionDefaults: () => {},
			},
			agents: [
				{
					name: "code-reviewer",
					description: "Reviews code",
					systemPrompt: "You are a code reviewer.",
				},
			],
		});

		expect(tool?.name).toBe("subagent_code_reviewer");
		expect(tool?.executionMode).toBe("parallel");
		expect(tool?.timeoutMs).toBe(300000);
		expect(tool?.retryable).toBe(false);
	});
});

describe("buildAgentRuntimeConfig", () => {
	const base = {
		providerId: "cline-pass",
		modelId: "cline-pass/muse-spark",
		apiKey: "parent-key",
		baseUrl: "https://parent.example/v1",
		headers: { Authorization: "Bearer parent-key" },
		cwd: "/proj",
		temperature: 0.3,
	};

	it("drops parent connection fields when the agent switches provider", () => {
		const out = buildAgentRuntimeConfig(base, {
			name: "coder",
			description: "codes",
			systemPrompt: "go",
			providerId: "openai-codex",
			modelId: "gpt-6-luna",
		});
		expect(out.providerId).toBe("openai-codex");
		expect(out.modelId).toBe("gpt-6-luna");
		// A foreign key/endpoint must never ride along: session bootstrap
		// resolves the worker provider's own stored credentials instead.
		expect(out.apiKey).toBeUndefined();
		expect(out.baseUrl).toBeUndefined();
		expect(out.headers).toBeUndefined();
		// Non-connection tuning still inherits.
		expect(out.cwd).toBe("/proj");
		expect(out.temperature).toBe(0.3);
	});

	it("keeps the connection when the agent stays on the parent provider", () => {
		const same = buildAgentRuntimeConfig(base, {
			name: "local",
			description: "same",
			systemPrompt: "go",
			providerId: "cline-pass",
			modelId: "other-model",
		});
		expect(same.apiKey).toBe("parent-key");
		const noOverride = buildAgentRuntimeConfig(base, {
			name: "plain",
			description: "plain",
			systemPrompt: "go",
		});
		expect(noOverride.providerId).toBe("cline-pass");
		expect(noOverride.apiKey).toBe("parent-key");
		expect(noOverride.baseUrl).toBe("https://parent.example/v1");
	});
});
