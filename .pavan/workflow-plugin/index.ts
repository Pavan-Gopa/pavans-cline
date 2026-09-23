// cline-pavans-workflow — Tier 0 port of Pavan's Workflow (OMP v3.4.x) to Cline.
//
// Main owns routing and file-backed state; fresh specialists do the work;
// deterministic gates and push-guards are machine-checked, the rest is policy
// the model follows. No Cline Desktop fork.
//
import { createTool, type AgentPlugin, type Message } from "@cline/core";
import type { AgentExtensionApi, AgentExtensionMessageBuilder, PluginSetupContext } from "@cline/shared";
import { handleWorkflowCommand } from "./command.js";
import {
  asStringRecord,
  beforeToolGuard,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  snapshotText,
} from "./guards.js";
import { WORKFLOW_RULES } from "./rules.js";
import { buildAssignmentPacket, validateSpawn, ROLE_ORDER, type RoleId } from "./roles.js";
import { configuredRoleCount, loadRoles, resolveRoute } from "./roles-config.js";
import { appendMetricsEvent, knownWorkspaceRoots, setWorkspaceRoot, workflowTools } from "./tools.js";
import { pickerTools } from "./picker.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_SCRIPT = join(MODULE_DIR, "..", "dashboard", "dashboard.mjs");

/** Best-effort board regen after each completed run. Never throws. */
function refreshBoard(): void {
  try {
    const root = knownWorkspaceRoots().next().value as string | undefined;
    if (!root || !existsSync(join(root, "AI_Workflow_Kit", "docs", "STEPS.md"))) return;
    const child = execFile("node", [DASHBOARD_SCRIPT, "--project", root, "--once"], { timeout: 30000 });
    child.on("error", () => {});
  } catch {
    // Board regen is display-only; it never affects routing or gates.
  }
}

/**
 * Conservative compaction: below budget the history passes through untouched.
 * Above budget the middle is replaced with a labelled placeholder that points
 * Main back at canonical files — never a fabricated summary.
 */
export const COMPACTION_CHAR_BUDGET = 120000;
export const COMPACTION_KEEP_HEAD = 2;
export const COMPACTION_KEEP_TAIL = 12;

function messageTextLength(message: Message): number {
  if (typeof message.content === "string") return message.content.length;
  let total = 0;
  for (const block of message.content) {
    if (block.type === "text") total += block.text.length;
    else if (block.type === "tool_result") {
      const content = block.content;
      if (typeof content === "string") total += content.length;
      else for (const part of content) total += part.type === "text" ? part.text.length : 0;
    } else if (block.type === "tool_use") total += JSON.stringify(block.input ?? "").length + block.name.length;
  }
  return total;
}

export function compactMessages(messages: Message[]): Message[] {
  let total = 0;
  for (const message of messages) total += messageTextLength(message);
  if (total <= COMPACTION_CHAR_BUDGET) return messages;
  if (messages.length <= COMPACTION_KEEP_HEAD + COMPACTION_KEEP_TAIL + 1) return messages;
  const head = messages.slice(0, COMPACTION_KEEP_HEAD);
  const tail = messages.slice(-COMPACTION_KEEP_TAIL);
  const omitted = messages.length - head.length - tail.length;
  const placeholder: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[pavans-workflow compaction: ${omitted} middle messages elided over budget, ` +
          `not summarized. Reread canonical state before routing: ` +
          `AI_Workflow_Kit/docs/AI/STATE.yaml, active STEPS.md card, git diff.]`,
      },
    ],
  };
  return [...head, placeholder, ...tail];
}

const plugin: AgentPlugin = {
  name: "cline-pavans-workflow",
  manifest: {
    capabilities: ["tools", "commands", "rules", "hooks", "messageBuilders"],
  },

  setup(api: AgentExtensionApi, ctx: PluginSetupContext) {
    setWorkspaceRoot(ctx.session?.sessionId, ctx.workspaceInfo?.rootPath);

    for (const rule of WORKFLOW_RULES) {
      api.registerRule({ id: rule.id, content: rule.content, source: "cline-pavans-workflow" });
    }
    for (const tool of workflowTools) {
      api.registerTool(tool);
    }

    for (const tool of pickerTools) {
      api.registerTool(tool);
    }

    api.registerTool(
      createTool({
        name: "workflow_spawn_packet",
        description:
          "Build a compact self-contained worker assignment packet. Routes auto-resolve from " +
          ".cline/workflow-roles.yaml (project) or ~/.cline/workflow-roles.yaml (global); explicit " +
          "provider_id/model_id override per call. Main then spawns ONE fresh subagent with the packet text. Never forwards transcripts.",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              enum: ["coder", "reviewer", "tester", "architect", "security", "design_advisor", "designer"],
              description: "Specialist role for the next fresh subagent.",
            },
            provider_id: { type: "string", description: "Route override. Omit to use the role's configured route." },
            model_id: { type: "string", description: "Route override. Omit to use the role's configured route." },
            reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"], description: "Reasoning override. Omit to use the role's configured level (absent = None)." },
            step: { type: "string", description: "Step id, e.g. S3." },
            work_item_id: { type: "string", description: "Stable ID from the active STEPS.md card." },
            goal: { type: "string", description: "One-paragraph goal for this worker." },
            target_files: { type: "array", items: { type: "string" } },
            exclusions: { type: "array", items: { type: "string" } },
            objective_gates: { type: "array", items: { type: "string" } },
            judgment_gates: { type: "array", items: { type: "string" } },
            ponytail_mode: { type: "string", enum: ["off", "lite", "full"] },
            retry_memory: { type: "string" },
            is_backup: { type: "boolean" },
            human_backup_authorization: { type: "string" },
            project: { type: "string", description: "Workspace root override for roles-file lookup. Defaults to the session root." },
          },
          required: ["role", "step", "work_item_id", "goal"],
        },
        execute: async (input: unknown) => {
          const args = asStringRecord(input) ?? {};
          const rawRole = optionalString(args, "role") ?? "coder";
          const role: RoleId = ROLE_ORDER.includes(rawRole as RoleId) ? (rawRole as RoleId) : "coder";
          const isBackup = optionalBoolean(args, "is_backup") ?? false;
          const { table, source } = loadRoles(optionalString(args, "project"));
          const route = resolveRoute(table, role, {
            providerId: optionalString(args, "provider_id"),
            modelId: optionalString(args, "model_id"),
            reasoning: optionalString(args, "reasoning_effort"),
            isBackup,
          });
          const gate = validateSpawn({
            role,
            route,
            isBackup,
            humanBackupAuthorization: optionalString(args, "human_backup_authorization"),
          });
          if (!gate.ok) return { ok: false, error: `${gate.error} (roles source: ${source})` };
          const ponytail = optionalString(args, "ponytail_mode");
          return {
            ok: true,
            packet: buildAssignmentPacket({
              role,
              route,
              step: optionalString(args, "step") ?? "",
              workItemId: optionalString(args, "work_item_id") ?? "",
              goal: optionalString(args, "goal") ?? "",
              targetFiles: optionalStringArray(args, "target_files") ?? [],
              exclusions: optionalStringArray(args, "exclusions") ?? [],
              objectiveGates: optionalStringArray(args, "objective_gates") ?? [],
              judgmentGates: optionalStringArray(args, "judgment_gates") ?? [],
              ponytailMode: ponytail === "off" || ponytail === "lite" ? ponytail : "full",
              retryMemory: optionalString(args, "retry_memory"),
              extra: isBackup
                ? `human_backup_authorization: true\nHuman instruction: ${optionalString(args, "human_backup_authorization")}`
                : undefined,
            }),
          };
        },
      }),
    );
    api.registerTool(
      createTool({
        name: "workflow_roles",
        description:
          "Show the role→route table (Alt+M replacement): per-role primary/backup provider/model, " +
          "which file it came from, and how many roles are spawn-ready. Read-only.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Workspace root override. Defaults to the session root." },
          },
        },
        execute: async (input: unknown) => {
          const args = asStringRecord(input) ?? {};
          const { table, source } = loadRoles(optionalString(args, "project"));
          const counts = configuredRoleCount(table);
          const roles: Record<string, unknown> = {};
          for (const role of ROLE_ORDER) {
            const entry = table[role];
            const ready = Boolean(entry.primary.providerId && entry.primary.modelId);
            const rsSuffix = (rt: { reasoning?: string }): string => (rt.reasoning ? `:${rt.reasoning}` : "");
            roles[role] = {
              primary: ready ? `${entry.primary.providerId}/${entry.primary.modelId}${rsSuffix(entry.primary)}` : "(unconfigured — spawn blocked)",
              backup: entry.backup.providerId && entry.backup.modelId
                ? `${entry.backup.providerId}/${entry.backup.modelId}${rsSuffix(entry.backup)}`
                : "(none)",
              spawn_ready: ready,
            };
          }
          return { ok: true, source, primary_configured: `${counts.primary}/7`, backup_configured: `${counts.backup}/7`, roles };
        },
      }),
    );

    api.registerCommand({
      name: "workflow",
      description:
        "Advance Pavan's file-backed multi-agent workflow: start|status|next <instruction>|why|metrics|designer advise|designer redesign|update.",
      handler: (input: string) => handleWorkflowCommand(input),
    });

    api.registerMessageBuilder({
      name: "pavans-workflow-compaction",
      build: (messages: Message[]) => compactMessages(messages),
    }) as AgentExtensionMessageBuilder;
  },

  hooks: {
    beforeTool(context: { toolCall?: unknown; tool?: unknown; input: unknown; snapshot: unknown }) {
      const callName = asStringRecord(context.toolCall)?.toolName;
      const toolName = typeof callName === "string" ? callName : (asStringRecord(context.tool)?.name ?? "unknown");
      const named = typeof toolName === "string" ? toolName : "unknown";
      const verdict = beforeToolGuard(named, context.input, snapshotText(context.snapshot));
      if (verdict) return { stop: verdict.stop, reason: verdict.reason };
      return undefined;
    },
    afterRun(context: { result?: { status?: string; iterations?: number } }) {
      if (context.result?.status !== "completed") return;
      appendMetricsEvent({
        ts: new Date().toISOString(),
        source: "cline-pavans-workflow",
        status: context.result.status,
        iterations: context.result.iterations,
      });
      refreshBoard();
    },
  },
};

export default plugin;
