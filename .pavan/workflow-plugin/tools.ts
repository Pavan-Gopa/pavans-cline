// Deterministic Main-loop tools — thin TS wrappers over the exact ported
// `scripts/workflow_gates.py` / `workflow_security_scope.py` (Pavan's Workflow
// 3.4.1), plus file-backed status and passive metrics readers.
//
// Tool errors are returned as structured data, never thrown: a throw counts
// against the agent's mistake budget, a returned error lets Main re-route.
// Tool inputs arrive as unknown JSON and are narrowed explicitly — the runtime
// validates inputSchema, this is defense in depth at the trust boundary.

import { createTool } from "@cline/core";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { asStringRecord, optionalNumber, optionalString, optionalStringArray } from "./guards.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** Bundled scripts — resolve via import.meta.url, never process.cwd(). */
export const SCRIPTS_DIR = join(MODULE_DIR, "..", "scripts");

const rootsBySession = new Map<string, string>();

export function setWorkspaceRoot(sessionId: string | undefined, root: string | undefined): void {
  if (sessionId && root) rootsBySession.set(sessionId, root);
}
/** Known session workspace roots (insertion order). Display layer only. */
export function knownWorkspaceRoots(): IterableIterator<string> {
  return rootsBySession.values();
}

/** Session root from setup(), else the host cwd. Never throws. */
export function resolveProjectRoot(override?: string): string {
  if (override) return override;
  const first = rootsBySession.values().next();
  return !first.done && first.value ? first.value : process.cwd();
}

interface ExecOutcome {
  exit: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function execFileAsync(file: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecOutcome> {
  const { promise, resolve } = Promise.withResolvers<ExecOutcome>();
  execFile(
    file,
    args,
    { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      const code: unknown = error?.code;
      const exit = typeof code === "number" ? code : error ? 124 : 0;
      resolve({
        exit,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: exit === 124,
      });
    },
  );
  return promise;
}

function tail(text: string, n = 2000): string {
  return text.length > n ? text.slice(-n) : text;
}

type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: string };

function safeJsonParse(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const workflowGatesRun = createTool({
  name: "workflow_gates_run",
  description:
    "Re-run the deterministic Objective Gates for the current (or named) STEPS.md step card. " +
    "Main MUST call this before dispatching Reviewer or closing a step as quick. " +
    "Returns gate results with exit codes and output tails; a failed gate blocks the transition.",
  inputSchema: {
    type: "object",
    properties: {
      step: { type: "string", description: "Step id, e.g. S3. Defaults to STATE.yaml current_step." },
      action: { type: "string", enum: ["run", "list"], description: "run executes command gates; list only parses. Default run." },
      timeout_s: { type: "number", description: "Per-gate timeout seconds. Default 120." },
      project: { type: "string", description: "Workspace root override. Defaults to the session root." },
    },
  },
  timeoutMs: 180000,
  retryable: false,
  execute: async (input: unknown) => {
    const args = asStringRecord(input) ?? {};
    const root = resolveProjectRoot(optionalString(args, "project"));
    const action = optionalString(args, "action") === "list" ? "list" : "run";
    const argv = [action, "--project", root, "--json"];
    const step = optionalString(args, "step");
    if (step) argv.push("--step", step);
    const timeoutS = optionalNumber(args, "timeout_s");
    if (timeoutS) argv.push("--timeout", String(Math.floor(timeoutS)));
    let outcome: ExecOutcome;
    try {
      outcome = await execFileAsync("python3", [join(SCRIPTS_DIR, "workflow_gates.py"), ...argv], root, 170000);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), root };
    }
    const parsed = safeJsonParse(outcome.stdout);
    const payload = parsed.ok ? asStringRecord(parsed.value) : undefined;
    if (!payload) {
      return {
        ok: false,
        exit: outcome.exit,
        stdout_tail: tail(outcome.stdout),
        stderr_tail: tail(outcome.stderr),
        parse_error: parsed.ok ? "expected a JSON object" : parsed.error,
        root,
      };
    }
    return { ok: outcome.exit === 0, exit: outcome.exit, root, ...payload };
  },
});

const workflowSecurityScope = createTool({
  name: "workflow_security_scope",
  description:
    "Classify changed paths for security/contract risk. Main MUST run this on every verified Coder diff. " +
    "forbid_quick=true forbids the quick profile (auth, credentials, secrets, trust boundaries, /api/, schemas, migrations). " +
    "offer_scoped=true means offer the Human a scoped Security pass.",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Explicit paths to classify. Omit to use git diff/untracked in the workspace.",
      },
      project: { type: "string", description: "Workspace root override. Defaults to the session root." },
    },
  },
  timeoutMs: 60000,
  retryable: false,
  execute: async (input: unknown) => {
    const args = asStringRecord(input) ?? {};
    const root = resolveProjectRoot(optionalString(args, "project"));
    const argv = ["--project", root, "--json", ...(optionalStringArray(args, "paths") ?? [])];
    let outcome: ExecOutcome;
    try {
      outcome = await execFileAsync("python3", [join(SCRIPTS_DIR, "workflow_security_scope.py"), ...argv], root, 50000);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), root };
    }
    const parsed = safeJsonParse(outcome.stdout);
    const payload = parsed.ok ? asStringRecord(parsed.value) : undefined;
    if (!payload) {
      return {
        ok: false,
        exit: outcome.exit,
        stdout_tail: tail(outcome.stdout),
        stderr_tail: tail(outcome.stderr),
        parse_error: parsed.ok ? "expected a JSON object" : parsed.error,
        root,
      };
    }
    return { ok: true, exit: outcome.exit, root, ...payload };
  },
});

const workflowStatus = createTool({
  name: "workflow_status",
  description:
    "Reconcile file-backed workflow state: STATE.yaml current step, STEPS.md step cards, git status/diff stat. " +
    "Main calls this at startup, resume, Human interrupt, and before every routing decision. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Workspace root override. Defaults to the session root." },
    },
  },
  timeoutMs: 30000,
  retryable: false,
  execute: async (input: unknown) => {
    const args = asStringRecord(input) ?? {};
    const root = resolveProjectRoot(optionalString(args, "project"));
    const statePath = join(root, "AI_Workflow_Kit", "docs", "AI", "STATE.yaml");
    const stepsPath = join(root, "AI_Workflow_Kit", "docs", "STEPS.md");
    const stepsCards: string[] = [];
    let currentStep = "";
    let stateHead = "";
    if (existsSync(statePath)) {
      const text = readFileSync(statePath, "utf8");
      stateHead = text.split("\n").slice(0, 40).join("\n");
      const match = /^current_step:\s*(.+?)\s*$/m.exec(text);
      if (match) currentStep = match[1].replace(/^['"]|['"]$/g, "").replace(/\s+#.*$/, "").trim();
    }
    if (existsSync(stepsPath)) {
      const text = readFileSync(stepsPath, "utf8");
      for (const match of text.matchAll(/^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)/gm)) {
        stepsCards.push(match[1]);
        if (stepsCards.length >= 50) break;
      }
    }
    let gitStatus = "";
    let gitDiffStat = "";
    try {
      const status = await execFileAsync("git", ["-C", root, "status", "--short"], root, 15000);
      gitStatus = tail(status.stdout, 4000);
      const diff = await execFileAsync("git", ["-C", root, "diff", "--stat"], root, 15000);
      gitDiffStat = tail(diff.stdout, 4000);
    } catch (error) {
      gitStatus = `git unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      ok: true,
      root,
      configured: existsSync(statePath) && existsSync(stepsPath),
      current_step: currentStep || null,
      step_cards: stepsCards,
      state_head: stateHead || null,
      git_status: gitStatus || "(clean)",
      git_diff_stat: gitDiffStat || "(no diff)",
    };
  },
});

const workflowMetricsReport = createTool({
  name: "workflow_metrics_report",
  description:
    "Report passive per-session workflow metrics (transitions by terminal status). " +
    "Metrics NEVER control routing or gates. Read-only.",
  inputSchema: { type: "object", properties: {} },
  timeoutMs: 30000,
  retryable: false,
  execute: async () => {
    const root = resolveProjectRoot();
    const file = join(root, "AI_Workflow_Kit", "docs", "AI", "metrics.jsonl");
    if (!existsSync(file)) return { ok: true, root, events: 0, by_status: {}, note: "no metrics recorded yet" };
    const byStatus: Record<string, number> = {};
    let events = 0;
    let last: unknown = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events += 1;
      const parsed = safeJsonParse(trimmed);
      const entry = parsed.ok ? asStringRecord(parsed.value) : undefined;
      if (entry) {
        const rawStatus: unknown = entry.status;
        const status = typeof rawStatus === "string" ? rawStatus : "unknown";
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        last = entry;
      }
      if (events >= 10000) break;
    }
    return { ok: true, root, events, by_status: byStatus, last_event: last };
  },
});

/** Append one passive metrics event. Never throws; never blocks routing. */
export function appendMetricsEvent(event: Record<string, unknown>): void {
  try {
    const root = resolveProjectRoot();
    const dir = join(root, "AI_Workflow_Kit", "docs", "AI");
    if (!existsSync(dir)) return;
    const file = join(dir, "metrics.jsonl");
    if (existsSync(file) && statSync(file).size > 1024 * 1024) return;
    appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    // Passive metrics failure never changes routing, gates, or product state.
  }
}

export const workflowTools = [workflowGatesRun, workflowSecurityScope, workflowStatus, workflowMetricsReport];
