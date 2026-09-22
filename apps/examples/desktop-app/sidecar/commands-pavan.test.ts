// [+pavan] commands-pavan contract: scoped workspace reads + roles writes.
// Runs under node:test (bun-independent). Injects bindingRoot directly —
// no upstream imports, so the test pins OUR guard logic, not their binding.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
