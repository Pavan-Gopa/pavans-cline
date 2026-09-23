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

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { ROLES, ROLE_ORDER, type RoleId } from "../../../../.pavan/workflow-plugin/roles.ts";
import { parseRolesYaml, type RolesTable } from "../../../../.pavan/workflow-plugin/roles-config.ts";
import { WORKFLOW_RULES } from "../../../../.pavan/workflow-plugin/rules.ts";
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
  const raw = (ctx.bindingRoot || "").trim();
  if (!raw || raw === "/") return "";
  return resolve(raw);
}

/**
 * Effective workflow root: explicit workspaceRoot from the webview wins.
 * The board always knows the opened folder; the sidecar binding only knows
 * its boot-time root, which in the packaged app is the filesystem root.
 * Binding root stays as fallback so older webviews keep working.
 */
function resolveRoot(ctx: PavanCommandContext, args?: Record<string, unknown>): string {
  const fromArgs = typeof args?.workspaceRoot === "string" ? args.workspaceRoot.trim() : "";
  for (const raw of [fromArgs, bindingRoot(ctx)]) {
    if (!raw || raw === "/") continue;
    try {
      if (!statSync(raw).isDirectory()) continue;
    } catch {
      continue;
    }
    return resolve(raw);
  }
  throw new Error("no workspace open — open a project folder first, then use the Workflow board");
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
    command !== "pavan_setup_workflow" &&
    command !== "pavan_ensure_project"
  ) {
    return null;
  }
  const root = resolveRoot(ctx, args);
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
    // Same save arms Main's spawn tools: one configured agent per configured
    // primary route, so subagent_workflow_<role> runs on the picked model.
    const agents = syncWorkflowAgents(root, parseRolesYaml(content));
    return { ok: true, file, agents };
  }
  if (command === "pavan_setup_workflow") {
    return setupWorkflowProject(root);
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

const WORKFLOW_AGENT_PREFIX = "workflow-";

const EMPTY_ROLES_YAML = [
  "# Role routes — managed by the Workflow board (Alt+W) and Roles (Alt+M). Hand edits welcome.",
  "# Empty = role blocked, never silently replaced.",
  "",
  "version: 1",
  "",
  "policy:",
  "  automatic_backup: false",
  "  require_human_backup_authorization: true",
  "",
  "roles:",
  ...(ROLE_ORDER as readonly RoleId[]).flatMap((r) => [
    `  ${r}:`,
    `    primary: { provider: "", model: "" }`,
    `    backup: { provider: "", model: "" }`,
    "",
  ]),
].join("\n");

/**
 * Mirror of the roles file for Cline's own spawn machinery: one configured
 * agent per configured primary route, so `subagent_workflow_<role>` tools run
 * on the model picked on the board / Alt+M. Empty roles delete their stale
 * file — a cleared role must block, never route to yesterday's model.
 * Reasoning effort has no slot in agent frontmatter; it rides the assignment
 * packet and the board display instead.
 */
export function syncWorkflowAgents(root: string, table: RolesTable): string[] {
  mkdirSync(join(root, ".cline", "agents"), { recursive: true });
  const dir = confinedPath(root, join(root, ".cline", "agents"));
  const synced: string[] = [];
  for (const role of ROLE_ORDER as readonly RoleId[]) {
    const file = join(dir, `${WORKFLOW_AGENT_PREFIX}${role}.yaml`);
    const route = table[role]?.primary;
    if (!route?.providerId || !route?.modelId) {
      try {
        unlinkSync(file);
      } catch {
        // Already absent — a cleared role simply has no spawn tool.
      }
      continue;
    }
    const preset = ROLES[role];
    const effort = route.reasoning
      ? `\n\nBoard-requested reasoning effort: ${route.reasoning}. Cline runs workers on the session default; treat harder assignments with proportionally deeper thinking.`
      : "";
    writeFileSync(
      file,
      [
        "---",
        `name: ${WORKFLOW_AGENT_PREFIX}${role}`,
        `description: ${JSON.stringify(`Pavan's Workflow ${role}: ${preset.purpose}`)}`,
        `providerId: ${JSON.stringify(route.providerId)}`,
        `modelId: ${JSON.stringify(route.modelId)}`,
        "---",
        `${preset.systemPrompt}${effort}`,
        "",
      ].join("\n"),
    );
    synced.push(file);
  }
  return synced;
}

function workflowRulesMarkdown(): string {
  // Tool names are Cline's deterministic sanitize (hyphens → underscores,
  // short names keep no hash suffix): subagent_workflow_coder, …
  const tools = (ROLE_ORDER as readonly RoleId[])
    .map((r) => `- subagent_workflow_${r} (role: ${r}) — ${ROLES[r].purpose}`)
    .join("\n");
  const rules = WORKFLOW_RULES.map((r) => `### ${r.id}\n\n${r.content}`).join("\n\n");
  return [
    "# Pavan's Workflow — Main orchestrator contract",
    "",
    "> Managed by the Workflow board (Alt+W) and Roles (Alt+M). Hand edits welcome,",
    "> but role routes live in `.cline/workflow-roles.yaml` — this file is Main's",
    "> instructions, not the routes.",
    ">",
    "> This session is Main: the sole orchestrator. Worker routes are independent",
    "> per-role provider/model pairs (`.cline/agents/workflow-*.yaml`) and apply",
    "> to the next fresh spawn. Backup routes need explicit Human words per use.",
    "",
    "## Spawn tools (one fresh worker at a time, never parallel on one workspace)",
    "",
    tools,
    "",
    "## Invariants",
    "",
    rules,
    "",
  ].join("\n");
}

/**
 * One-time project setup: roles file (empty = every spawn blocked), Main's
 * rule file, nothing else. Never overwrites existing files; never touches
 * STATE.yaml / STEPS.md — planning memory stays Main's job.
 */
export function setupWorkflowProject(root: string): { ok: true; created: string[]; workspaceRoot: string } {
  const created: string[] = [];
  mkdirSync(join(root, ".cline"), { recursive: true });
  const dir = confinedPath(root, join(root, ".cline"));
  const rolesFile = join(dir, "workflow-roles.yaml");
  if (!existsSync(rolesFile)) {
    writeFileSync(rolesFile, EMPTY_ROLES_YAML);
    created.push(rolesFile);
  }
  mkdirSync(join(dir, "rules"), { recursive: true });
  const rulesFile = join(confinedPath(root, join(dir, "rules")), "pavans-workflow.md");
  if (!existsSync(rulesFile)) {
    writeFileSync(rulesFile, workflowRulesMarkdown());
    created.push(rulesFile);
  }
  return { ok: true as const, created, workspaceRoot: root };
}
