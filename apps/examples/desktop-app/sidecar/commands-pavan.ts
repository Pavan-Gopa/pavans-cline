// [+pavan] sidecar workspace-file commands for the Workflow board pane.
//
// Three minimal commands on the existing handleCommand dispatcher —
// read-only text reads + scoped roles-file writes. Same trust level as
// the chat tools (bash/editor) the agent already has; narrower scope:
// only AI_Workflow_Kit/**, .cline/workflow-roles.yaml. Absolute paths only,
// confined to the caller's runtime binding root (local or SSH — binding
// decides), 1 MiB cap, UTF-8, no symlinks escaping the root (realpath check).
//
// Wiring: handlePavanCommand(ctx, command, args) is called FIRST in
// handleCommand (sidecar/commands.ts [+pavan:6]); unknown names return
// null → fall through to the existing dispatcher.
//
// No import from ./commands (cycle): the binding root arrives resolved.
// commands.ts passes getCommandRuntimeBinding(ctx, args).workspaceRoot
// as ctx.bindingRoot. Tests inject bindingRoot directly.

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
const READABLE_SUFFIXES = [
  "/AI_Workflow_Kit/docs/AI/STATE.yaml",
  "/AI_Workflow_Kit/docs/STEPS.md",
  "/AI_Workflow_Kit/docs/DECISIONS.md",
  "/AI_Workflow_Kit/docs/PROJECT_CONTEXT.md",
  "/AI_Workflow_Kit/docs/AI/FEEDBACK.md",
  "/AI_Workflow_Kit/docs/AI/metrics.jsonl",
  "/.cline/workflow-roles.yaml",
];

export interface PavanCommandContext {
  /** Resolved by commands.ts via getCommandRuntimeBinding(ctx, args). */
  bindingRoot: string;
}

function bindingRoot(ctx: PavanCommandContext): string {
  return resolve(ctx.bindingRoot || "/");
}

function confinedPath(root: string, absPath: string): string {
  if (!isAbsolute(absPath)) throw new Error("absolute path required");
  const real = realpathSync(absPath);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error("path escapes the workspace root");
  }
  return real;
}

function assertReadable(root: string, absPath: string): string {
  const real = confinedPath(root, absPath);
  const rel = real.slice(realpathSync(root).length) || "/";
  const ok = READABLE_SUFFIXES.some((s) => rel === s || rel.endsWith(s));
  if (!ok) throw new Error(`not a workflow-readable file: ${rel}`);
  return real;
}

const MAX_FILE_BYTES = 1024 * 1024;

export async function handlePavanCommand(
  ctx: PavanCommandContext,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown | null> {
  if (
    command !== "pavan_read_workspace_files" &&
    command !== "pavan_write_workflow_roles" &&
    command !== "pavan_ensure_project"
  ) {
    return null;
  }
  const root = bindingRoot(ctx);
  if (command === "pavan_read_workspace_files") {
    const paths = args?.paths;
    if (!Array.isArray(paths)) throw new Error("paths: string[] required");
    const out: Record<string, string | null> = {};
    for (const p of paths.slice(0, 16)) {
      if (typeof p !== "string") continue;
      try {
        const real = assertReadable(root, p);
        const st = statSync(real);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) {
          out[p] = null;
          continue;
        }
        out[p] = readFileSync(real, "utf8");
      } catch {
        out[p] = null;
      }
    }
    return { files: out };
  }
  if (command === "pavan_write_workflow_roles") {
    const content = args?.content;
    if (typeof content !== "string" || !content.length || content.length > 64 * 1024) {
      throw new Error("content: non-empty string ≤64KiB required");
    }
    // Parent may not exist yet: create it under root first (mkdir cannot
    // escape — join(root, ".cline") stays inside by construction), then
    // realpath-verify it still resolves inside root (catches pre-planted
    // symlink swaps between mkdir and write — TOCTOU-safe enough: the
    // final write target is re-derived from the verified real dir).
    mkdirSync(join(root, ".cline"), { recursive: true });
    const dir = confinedPath(root, join(root, ".cline"));
    const file = join(dir, "workflow-roles.yaml");
    writeFileSync(file, content);
    return { ok: true, file };
  }
  // pavan_ensure_project — lazy seed guard (mirrors dashboard ensureProject).
  const liveState = join(root, "AI_Workflow_Kit", "docs", "AI", "STATE.yaml");
  const steps = join(root, "AI_Workflow_Kit", "docs", "STEPS.md");
  const hasLive = existsSync(liveState) || existsSync(join(root, ".omp"));
  if (hasLive && !existsSync(steps)) {
    throw new Error("live workflow memory without STEPS.md — restore it or pick another folder");
  }
  return { ok: true, live: hasLive };
}
