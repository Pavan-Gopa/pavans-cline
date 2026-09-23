// [+pavan] commands-pavan contract: scoped workspace reads + roles writes.
// Runs under node:test (bun-independent). Injects bindingRoot directly —
// no upstream imports, so the test pins OUR guard logic, not their binding.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handlePavanCommand } from "./commands-pavan";

function ctx(root: string): { bindingRoot: string } {
  return { bindingRoot: root };
}

test("reads allowlisted files, refuses the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "pavan-cmd-"));
  mkdirSync(join(root, "AI_Workflow_Kit", "docs", "AI"), { recursive: true });
  writeFileSync(join(root, "AI_Workflow_Kit", "docs", "AI", "STATE.yaml"), "current_step: S1\n");
  writeFileSync(join(root, "package.json"), '{"secret": true}');
  const res = (await handlePavanCommand(ctx(root), "pavan_read_workspace_files", {
    paths: [`${root}/AI_Workflow_Kit/docs/AI/STATE.yaml`, `${root}/package.json`, "/etc/passwd"],
  })) as { files: Record<string, string | null> };
  assert.equal(res.files[`${root}/AI_Workflow_Kit/docs/AI/STATE.yaml`], "current_step: S1\n");
  assert.equal(res.files[`${root}/package.json`], null);
  assert.equal(res.files["/etc/passwd"], null);
});

test("unknown command returns null (dispatcher fall-through)", async () => {
  assert.equal(await handlePavanCommand(ctx("/tmp"), "nope", {}), null);
});

test("writes only the roles file, confined to root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pavan-cmd-"));
  const ok = (await handlePavanCommand(ctx(root), "pavan_write_workflow_roles", { content: "version: 1\n" })) as {
    ok: boolean;
    file: string;
  };
  assert.equal(ok.ok, true);
  // macOS /tmp symlinks to /private/tmp: compare realpaths, not literals.
  assert.equal(ok.file, join(realpathSync(join(root, ".cline")), "workflow-roles.yaml"));
  await assert.rejects(() => handlePavanCommand(ctx(root), "pavan_write_workflow_roles", { content: "" }));
});
test("ensureProject refuses live memory without STEPS.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "pavan-cmd-"));
  mkdirSync(join(root, "AI_Workflow_Kit", "docs", "AI"), { recursive: true });
  writeFileSync(join(root, "AI_Workflow_Kit", "docs", "AI", "STATE.yaml"), "current_step: S0\n");
  await assert.rejects(() => handlePavanCommand(ctx(root), "pavan_ensure_project", {}));
});

test("roles save arms per-role spawn agents, clearing removes them", async () => {
  const root = mkdtempSync(join(tmpdir(), "pavan-cmd-"));
  const yaml = [
    "roles:",
    "  coder:",
    '    primary: { provider: "openai-codex", model: "gpt-6-astra", reasoning: "max" }',
    '    backup: { provider: "", model: "" }',
    "  reviewer:",
    '    primary: { provider: "", model: "" }',
    '    backup: { provider: "", model: "" }',
  ].join("\n");
  const ok = (await handlePavanCommand(ctx(root), "pavan_write_workflow_roles", {
    content: yaml,
    workspaceRoot: root,
  })) as { ok: boolean; agents: string[] };
  assert.equal(ok.ok, true);
  assert.equal(ok.agents.length, 1);
  const agent = readFileSync(join(root, ".cline", "agents", "workflow-coder.yaml"), "utf8");
  assert.match(agent, /name: workflow-coder/);
  assert.match(agent, /modelId: "gpt-6-astra"/);
  assert.match(agent, /Board-requested reasoning effort: max/);
  // Clearing the role deletes the stale spawn tool — never route to old models.
  const cleared = [
    "roles:",
    "  coder:",
    '    primary: { provider: "", model: "" }',
    '    backup: { provider: "", model: "" }',
  ].join("\n");
  await handlePavanCommand(ctx(root), "pavan_write_workflow_roles", {
    content: cleared,
    workspaceRoot: root,
  });
  assert.equal(existsSync(join(root, ".cline", "agents", "workflow-coder.yaml")), false);
});

test("setup scaffolds roles and Main rules without overwriting", async () => {
  const root = mkdtempSync(join(tmpdir(), "pavan-cmd-"));
  const first = (await handlePavanCommand(ctx(root), "pavan_setup_workflow", {
    workspaceRoot: root,
  })) as { ok: boolean; created: string[] };
  assert.equal(first.ok, true);
  assert.equal(first.created.length, 2);
  const rules = readFileSync(join(root, ".cline", "rules", "pavans-workflow.md"), "utf8");
  assert.match(rules, /subagent_workflow_coder/);
  assert.match(rules, /sole orchestrator/i);
  const second = (await handlePavanCommand(ctx(root), "pavan_setup_workflow", {
    workspaceRoot: root,
  })) as { ok: boolean; created: string[] };
  assert.deepEqual(second.created, []);
});

test("explicit workspaceRoot wins over a broken binding root", async () => {
  const root = mkdtempSync(join(tmpdir(), "pavan-cmd-"));
  mkdirSync(join(root, "AI_Workflow_Kit", "docs", "AI"), { recursive: true });
  writeFileSync(join(root, "AI_Workflow_Kit", "docs", "AI", "STATE.yaml"), "current_step: S9\n");
  // Packaged app boots its sidecar at filesystem root: binding "/" must not
  // block the board when the webview knows the real folder.
  const res = (await handlePavanCommand(ctx("/"), "pavan_read_workspace_files", {
    paths: [`${root}/AI_Workflow_Kit/docs/AI/STATE.yaml`],
    workspaceRoot: root,
  })) as { files: Record<string, string | null> };
  assert.equal(res.files[`${root}/AI_Workflow_Kit/docs/AI/STATE.yaml`], "current_step: S9\n");
  const ok = (await handlePavanCommand(ctx("/"), "pavan_write_workflow_roles", {
    content: "version: 1\n",
    workspaceRoot: root,
  })) as { ok: boolean; file: string };
  assert.equal(ok.ok, true);
  assert.equal(ok.file, join(realpathSync(join(root, ".cline")), "workflow-roles.yaml"));
});

test("missing workspace everywhere errors in English", async () => {
  await assert.rejects(
    () => handlePavanCommand(ctx("/"), "pavan_write_workflow_roles", { content: "version: 1\n" }),
    /no workspace open/,
  );
});
