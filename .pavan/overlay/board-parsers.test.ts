// [+pavan] board-parsers contract: mirrors .pavan/board/dashboard.mjs.
// Any behavior change here MUST land in both files + this test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadParsers(): Promise<typeof import("./board-parsers.ts")> {
  // Strip-types runtime: board-parsers.ts is dependency-free TS.
  return (await import("./board-parsers.ts")) as typeof import("./board-parsers.ts");
}

test("state: nested keys read with indentation", async () => {
  const { parseWorkflowState } = await loadParsers();
  const s = parseWorkflowState(
    "current_step: S1\nimplementation:\n  status: running\npipeline:\n  profile: standard\n  quick_forbidden: true\n",
  );
  assert.equal(s.current_step, "S1");
  assert.equal(s.status, "running");
  assert.equal(s.pipeline_profile, "standard");
  assert.equal(s.quick_forbidden, "true");
});

test("steps: loose Verification attaches to the card, templates skipped", async () => {
  const { parseWorkflowSteps } = await loadParsers();
  const text = [
    "## S1 — Short title",
    "",
    "**Do:**",
    "- [ ] [S1.D1] work",
    "",
    "## Verification",
    "",
    "### Objective gates",
    "",
    "- [ ] [S1.O1] `node -e \"process.exit(0)\"` exits 0",
    "### Judgment gates",
    "",
    "- [ ] [S1.J1] sane",
    "",
    "## S1 — _(title)_",
    "",
    "- [ ] template item",
    "",
  ].join("\n");
  const cards = parseWorkflowSteps(text);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, "S1");
  assert.deepEqual(
    cards[0].items.map((i) => `${i.kind}:${i.id}`),
    ["do:S1.D1", "objective:S1.O1", "judgment:S1.J1"],
  );
});

test("roles: inline + block forms, backup preserved", async () => {
  const { parseRolesYaml, isRouteReady } = await loadParsers();
  const { table } = parseRolesYaml(
    [
      "roles:",
      "  coder:",
      '    primary: { provider: "anthropic", model: "claude-opus-4-5" }',
      "    backup: { provider: \"\", model: \"\" }",
      "  reviewer:",
      "    primary:",
      '      provider: "openai-codex"',
      '      model: "gpt-5.5"',
      "",
    ].join("\n"),
    ["coder", "reviewer"],
  );
  assert.equal(table.coder.primary, "anthropic/claude-opus-4-5");
  assert.equal(table.reviewer.primary, "openai-codex/gpt-5.5");
  assert.ok(isRouteReady(table.coder.primary));
  assert.ok(!isRouteReady(""));
});

test("dashboard.mjs parity: same fixture, same card/item count", async () => {
  const { parseWorkflowSteps } = await loadParsers();
  const kitSteps = join(HERE, "..", "..", "..", "Documents", "AI Projects", "Pavan's Workflow", "AI_Workflow_Kit", "docs", "STEPS.md");
  let text: string;
  try {
    text = readFileSync(kitSteps, "utf8");
  } catch {
    return; // kit path machine-specific; parser unit tests above still pin behavior
  }
  const cards = parseWorkflowSteps(text);
  assert.deepEqual(
    cards.map((c) => c.id),
    ["S1", "S0"],
  );
  const s1 = cards.find((c) => c.id === "S1");
  assert.ok(s1 && s1.total === 6, `S1 should carry 2 do + 2 objective + 2 judgment, got ${s1?.total}`);
});
