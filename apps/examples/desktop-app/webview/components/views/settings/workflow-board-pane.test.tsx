// @vitest-environment jsdom
// [+pavan] Regression: saved role routes must reseed provider/model/effort
// selects on mount (leaving Workflow and coming back shows assignments).
// Renders the REAL pane against DialGent-shaped files.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowBoardPane } from "../../../../../../../.pavan/overlay/workflow-board-pane";

vi.mock("@/lib/provider-model-catalog", () => ({
	fetchProviderCatalog: vi.fn(async () => ({
		providers: [
			{ id: "openai-codex", name: "OpenAI Codex", configured: true },
			{ id: "cline-pass", name: "Cline Pass", configured: true },
			{ id: "xai-oauth", name: "Grok", configured: true },
		],
	})),
	loadProviderModels: vi.fn(async (provider: string) => {
		const eff = (values: string[]) => [{ type: "effort", values }];
		const table: Record<string, Array<{ id: string; reasoningOptions: unknown }>> = {
			"openai-codex": [
				{ id: "gpt-6-luna", reasoningOptions: eff(["low", "medium", "high", "xhigh", "max"]) },
				{ id: "gpt-6-astra", reasoningOptions: eff(["low", "medium", "high", "xhigh"]) },
			],
			"cline-pass": [
				{
					id: "cline-free/muse-spark-1.3-contributor",
					reasoningOptions: eff(["low", "medium", "high", "xhigh", "max"]),
				},
			],
			"xai-oauth": [{ id: "grok-4.7", reasoningOptions: eff(["low", "medium", "high", "xhigh"]) }],
		};
		return table[provider] ?? [];
	}),
}));

const ROLES_YAML = [
	"# Role routes",
	"version: 1",
	"roles:",
	"  coder:",
	'    primary: { provider: "openai-codex", model: "gpt-6-luna", reasoning: "max"}',
	'    backup: { provider: "", model: "" }',
	"  reviewer:",
	'    primary: { provider: "cline-pass", model: "cline-free/muse-spark-1.3-contributor", reasoning: "max"}',
	'    backup: { provider: "", model: "" }',
	"  tester:",
	'    primary: { provider: "xai-oauth", model: "grok-4.7", reasoning: "high"}',
	'    backup: { provider: "", model: "" }',
	"  architect:",
	'    primary: { provider: "openai-codex", model: "gpt-6-astra", reasoning: "high"}',
	'    backup: { provider: "", model: "" }',
	"  security:",
	'    primary: { provider: "", model: ""}',
	'    backup: { provider: "", model: "" }',
	"  design_advisor:",
	'    primary: { provider: "", model: ""}',
	'    backup: { provider: "", model: "" }',
	"  designer:",
	'    primary: { provider: "", model: ""}',
	'    backup: { provider: "", model: "" }',
].join("\n");

const STATE_YAML = "current_step: S12\nstatus: running\n";
const STEPS_MD = "## S12 — DialGent\n\n**Do:**\n- [ ] [S12.D1] work\n";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.clearAllMocks();
});

async function flush(effects = 12): Promise<void> {
	for (let i = 0; i < effects; i += 1) {
		await act(async () => {});
	}
}

function selectValue(label: string): string {
	const el = container.querySelector(`select[aria-label="${label}"]`);
	if (!(el instanceof HTMLSelectElement)) throw new Error(`missing select ${label}`);
	return el.value;
}

describe("WorkflowBoardPane reseed", () => {
	it("fills model and effort from the saved roles file on mount", async () => {
		const io = {
			readFile: vi.fn(async (absPath: string): Promise<string | null> => {
				if (absPath.endsWith("workflow-roles.yaml")) return ROLES_YAML;
				if (absPath.endsWith("STATE.yaml")) return STATE_YAML;
				if (absPath.endsWith("STEPS.md")) return STEPS_MD;
				return null;
			}),
			writeFile: vi.fn(async () => {}),
			setupProject: vi.fn(async () => ({ ok: true, created: [] })),
		};
		await act(async () => {
			root.render(<WorkflowBoardPane workspace="/proj" io={io} />);
		});
		await flush();
		expect(selectValue("coder provider")).toBe("openai-codex");
		expect(selectValue("coder model")).toBe("gpt-6-luna");
		expect(selectValue("coder reasoning effort")).toBe("max");
		expect(selectValue("tester model")).toBe("grok-4.7");
		expect(selectValue("tester reasoning effort")).toBe("high");
	});
});
