// Enforcement hooks — the only hard gates in the plugin. Everything else is
// policy text the model follows; these two invariants are machine-checked:
//
// 1. Workers never write canonical workflow memory (STATE.yaml, STEPS.md,
//    DECISIONS.md, FEEDBACK.md). Detection is heuristic: the session history
//    contains a worker assignment packet (`role: <id> (...)`), which Main
//    sessions never contain. Main writes are unaffected.
// 2. Nobody runs `git commit` / `git push` without an explicit recorded Human
//    authorization token in the session history. Checkpoints stay Main-owned
//    and Human-approved.

const WORKER_ROLE_RE = /^role:\s*(coder|reviewer|tester|architect|security|design_advisor|designer)\b/im;
const COMMIT_AUTH_RE = /human_commit_authorization:\s*true/i;
const GIT_MUTATE_RE = /\bgit\s+(commit|push)\b/;
const CANONICAL_STATE_RE = /(^|\/)AI_Workflow_Kit\/docs\/(AI\/STATE\.yaml|STEPS\.md|DECISIONS\.md|AI\/FEEDBACK\.md)$/;

const EDIT_TOOL_RE = /^(editor|apply_patch|write|edit)$/i;
const BASH_TOOL_RE = /^(bash|run_commands|exec|shell|run_command)$/i;

/** Object view over unknown tool input. Index access needs the Record shape. */
export function asStringRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

export function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value: unknown = record[key];
  return typeof value === "string" ? value : undefined;
}

export function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value: unknown = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value: unknown = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value: unknown = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    strings.push(entry);
  }
  return strings;
}

export function isCanonicalStateFile(path: string): boolean {
  return CANONICAL_STATE_RE.test(path.replace(/\\/g, "/"));
}

export function isWorkerSession(messagesText: string): boolean {
  return WORKER_ROLE_RE.test(messagesText);
}

export function hasCommitAuthorization(messagesText: string): boolean {
  return COMMIT_AUTH_RE.test(messagesText);
}

/** Best-effort text extraction from a runtime snapshot for guard matching. */
export function snapshotText(snapshot: unknown): string {
  const record = asStringRecord(snapshot);
  if (!record) return "";
  const messages: unknown = record.messages;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages.slice(-40)) {
    const content: unknown = asStringRecord(message)?.content;
    if (typeof content === "string") parts.push(content);
    else if (content !== undefined) {
      try {
        parts.push(JSON.stringify(content));
      } catch {
        parts.push("[unserializable]");
      }
    }
    if (parts.join("\n").length > 20000) break;
  }
  return parts.join("\n").slice(-20000);
}

function stringField(input: unknown, keys: string[]): string | undefined {
  if (typeof input === "string") return input;
  const record = asStringRecord(input);
  if (!record) return undefined;
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Target file paths for file-writing tools. Empty when not determinable. */
export function extractTargetPaths(toolName: string, input: unknown): string[] {
  if (!EDIT_TOOL_RE.test(toolName)) return [];
  const paths: string[] = [];
  const single = stringField(input, ["path", "file", "filePath", "target", "filename"]);
  if (single) paths.push(single);
  const files: unknown = asStringRecord(input)?.files;
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (typeof entry === "string") paths.push(entry);
      else {
        const nested = stringField(entry, ["path", "file", "filePath", "target"]);
        if (nested) paths.push(nested);
      }
    }
  }
  return paths;
}

/** Command text for shell tools. Empty when not determinable. */
export function extractBashText(input: unknown): string {
  if (typeof input === "string") return input;
  const record = asStringRecord(input);
  if (!record) return "";
  const direct = stringField(record, ["command", "cmd"]);
  if (direct) return direct;
  const commands: unknown = record.commands;
  if (Array.isArray(commands)) {
    return commands.filter((entry): entry is string => typeof entry === "string").join("\n");
  }
  return "";
}

export interface GuardVerdict {
  stop: boolean;
  reason: string;
}

/**
 * Pure guard decision — unit-testable without the runtime.
 * Returns a stop verdict or undefined to let execution continue.
 */
export function beforeToolGuard(toolName: string, input: unknown, messagesText: string): GuardVerdict | undefined {
  if (BASH_TOOL_RE.test(toolName)) {
    const bashText = extractBashText(input);
    if (bashText && GIT_MUTATE_RE.test(bashText) && !hasCommitAuthorization(messagesText)) {
      return {
        stop: true,
        reason:
          "Pavan's Workflow guard: git commit/push requires explicit Human authorization recorded as `human_commit_authorization: true`. " +
          "Workers never commit or push. Main: obtain Human approval, record it, then re-run.",
      };
    }
    return undefined;
  }
  if (EDIT_TOOL_RE.test(toolName)) {
    const targets = extractTargetPaths(toolName, input);
    const hit = targets.find((target) => isCanonicalStateFile(target));
    if (hit && isWorkerSession(messagesText)) {
      return {
        stop: true,
        reason:
          `Pavan's Workflow guard: worker sessions never write canonical workflow memory (blocked: ${hit}). ` +
          "Main alone owns STATE.yaml, STEPS.md, DECISIONS.md, FEEDBACK.md. Return findings in the structured result instead.",
      };
    }
    return undefined;
  }
  return undefined;
}
