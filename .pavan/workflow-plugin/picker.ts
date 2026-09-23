// picker.ts — the Alt+M replacement: browse real providers and models,
// assign them to workflow roles without hand-editing YAML.
//
// Three tools share one cached catalog layer over the real Cline registries:
//   workflow_providers          — all 226 providers, configured-first
//   workflow_models <provider>  — that provider's real model catalog (+ live proxy for openai-compatible/Grok)
//   workflow_pick               — assign {provider, model} to a role: writes the project roles file
//
// Reads use getAllProviders/getModelsForProvider (async, from @cline/llms via
// @cline/core's Llms namespace) plus ProviderSettingsManager for the
// configured set. Writes go ONLY to <project>/.cline/workflow-roles.yaml —
// never to providers.json, never to global settings.
import { createTool, Llms, ProviderSettingsManager } from "@cline/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { asStringRecord, optionalString } from "./guards.js";
import { loadRoles, type RolesTable } from "./roles-config.js";
import { ROLE_ORDER, type RoleId } from "./roles.js";
import { resolveProjectRoot } from "./tools.js";

const modelsCache = new Map<string, { at: number; ids: string[] }>();
const CATALOG_TTL_MS = 5 * 60 * 1000;

async function catalogModels(providerId: string): Promise<{ ids: string[]; live: boolean }> {
  const cached = modelsCache.get(providerId);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return { ids: cached.ids, live: false };
  const record = await Llms.getModelsForProvider(providerId);
  const ids = Object.keys(record ?? {});
  if (ids.length) modelsCache.set(providerId, { at: Date.now(), ids });
  return { ids, live: true };
}

/** Live Grok subscription models via the loopback proxy (when it is up). */
async function liveGrokModels(): Promise<string[]> {
  try {
    const res = await fetch("http://127.0.0.1:8099/v1/models", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const payload: unknown = await res.json();
    const data: unknown = asStringRecord(payload)?.data;
    if (!Array.isArray(data)) return [];
    const ids: string[] = [];
    for (const entry of data) {
      const id: unknown = asStringRecord(entry)?.id;
      if (typeof id === "string") ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}
/** Live Antigravity subscription models via its loopback proxy (when up). */
async function liveAntigravityModels(): Promise<string[]> {
  try {
    const res = await fetch("http://127.0.0.1:8097/v1/models", { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const payload: unknown = await res.json();
    const data: unknown = asStringRecord(payload)?.data;
    if (!Array.isArray(data)) return [];
    const ids: string[] = [];
    for (const entry of data) {
      const id: unknown = asStringRecord(entry)?.id;
      if (typeof id === "string") ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

function configuredProviderIds(): string[] {
  try {
    return Object.keys(new ProviderSettingsManager().read().providers ?? {});
  } catch {
    return [];
  }
}

function rolesFileFor(project?: string): string {
  const root = project ?? resolveProjectRoot();
  return join(root, ".cline", "workflow-roles.yaml");
}

/** Serialize back only the roles table; policy header is fixed. */
export interface SerializeRolesParams {
  table: RolesTable;
  updatedRole?: RoleId;
}

function serializeRoles(params: SerializeRolesParams): string {
  const lines = [
    "# Workflow role routes — managed by `workflow_pick`. Hand edits welcome.",
    "# Empty strings = unconfigured: spawning that role is BLOCKED, never silent.",
    "# Backups need explicit Human words per use; automatic_backup is always ignored.",
    "",
    "version: 1",
    "",
    "policy:",
    "  automatic_backup: false",
    "  require_human_backup_authorization: true",
    "",
    "roles:",
  ];
  for (const role of ROLE_ORDER) {
    const entry = params.table[role];
    const mark = params.updatedRole === role ? "  # <-- updated" : "";
    const rsPart = (rt: { reasoning?: string }): string => (rt.reasoning ? `, reasoning: "${rt.reasoning}"` : "");
    lines.push(`  ${role}:${mark}`);
    lines.push(`    primary: { provider: "${entry.primary.providerId}", model: "${entry.primary.modelId}"${rsPart(entry.primary)} }`);
    lines.push(`    backup: { provider: "${entry.backup.providerId}", model: "${entry.backup.modelId}"${rsPart(entry.backup)} }`);
    lines.push("");
  }
  return lines.join("\n");
}

const workflowProviders = createTool({
  name: "workflow_providers",
  description:
    "List Cline providers for role assignment (Alt+M step 1): configured providers first with credential state, then the full catalog. " +
    "Main calls this, shows the Human a numbered list, and asks which provider goes on the role. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Case-insensitive substring filter over id/name. Omit for all." },
      limit: { type: "number", description: "Max rows. Default 40." },
    },
  },
  timeoutMs: 60000,
  retryable: false,
  execute: async (input: unknown) => {
    const args = asStringRecord(input) ?? {};
    const query = (optionalString(args, "query") ?? "").toLowerCase();
    const all = await Llms.getAllProviders();
    const configured = new Set(configuredProviderIds());
    const match = (id: string, name: string): boolean =>
      !query || id.toLowerCase().includes(query) || name.toLowerCase().includes(query);
    const rows = all
      .filter((p: { id: string; name?: string }) => match(p.id, p.name ?? ""))
      .map((p: { id: string; name?: string }) => ({ id: p.id, name: p.name ?? p.id, configured: configured.has(p.id) }))
      .sort((a: { id: string; configured: boolean }, b: { id: string; configured: boolean }) => Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));
    const limitRaw: unknown = args.limit;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(226, Math.floor(limitRaw)))
      : 40;
    return {
      ok: true,
      configured_count: configured.size,
      catalog_count: all.length,
      providers: rows.slice(0, limit),
      truncated: rows.length > limit,
      hint: "Ask the Human: provider number for the role? Then call workflow_models with that provider id.",
    };
  },
});

const workflowModels = createTool({
  name: "workflow_models",
  description:
    "List a provider's real models for role assignment (Alt+M step 2): catalog ids with context/reasoning flags. " +
    "For openai-compatible also merges live Grok subscription models from the loopback proxy when it is up. " +
    "Main shows a numbered list and asks which model. Read-only.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Provider id from workflow_providers, e.g. anthropic, openai-codex." },
      query: { type: "string", description: "Case-insensitive substring filter over model id/name." },
      limit: { type: "number", description: "Max rows. Default 40." },
    },
    required: ["provider"],
  },
  timeoutMs: 60000,
  retryable: false,
  execute: async (input: unknown) => {
    const args = asStringRecord(input) ?? {};
    const providerId = optionalString(args, "provider") ?? "";
    if (!providerId) return { ok: false, error: "provider is required — call workflow_providers first" };
    const query = (optionalString(args, "query") ?? "").toLowerCase();
    const record = await Llms.getModelsForProvider(providerId).catch(() => ({} as Record<string, unknown>));
    const ids = new Set(Object.keys(record ?? {}));
    let liveGrok: string[] = [];
    let liveAntigravity: string[] = [];
    if (providerId === "openai-compatible") {
      liveGrok = await liveGrokModels();
      for (const id of liveGrok) ids.add(id);
      liveAntigravity = await liveAntigravityModels();
      for (const id of liveAntigravity) ids.add(id);
    }
    const allIds = [...ids].filter((id) => !query || id.toLowerCase().includes(query)).sort();
    const limitRaw: unknown = args.limit;
    const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 40;
    return {
      ok: true,
      provider: providerId,
      count: allIds.length,
      live_grok_models: liveGrok.length,
      live_antigravity_models: liveAntigravity.length,
      models: allIds.slice(0, limit),
      truncated: allIds.length > limit,
      hint: "Ask the Human: model number? Then call workflow_pick with role + provider + model.",
    };
  },
});

const workflowPick = createTool({
  name: "workflow_pick",
  description:
    "Assign a provider+model to a workflow role (Alt+M step 3): validates the pair against the real catalog, " +
    "then writes ONLY the project .cline/workflow-roles.yaml (primary, or backup with explicit Human words). " +
    "Never touches providers.json or global settings. Backup requires human_backup_authorization.",
  inputSchema: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["coder", "reviewer", "tester", "architect", "security", "design_advisor", "designer"],
        description: "Role to assign.",
      },
      provider: { type: "string", description: "Provider id from workflow_providers." },
      model: { type: "string", description: "Model id from workflow_models." },
      slot: { type: "string", enum: ["primary", "backup"], description: "Which slot. Default primary." },
      reasoning: { type: "string", enum: ["low", "medium", "high", "xhigh"], description: "Reasoning effort for this role. Omit = None." },
      human_backup_authorization: { type: "string", description: "Exact Human words; required for slot=backup." },
      project: { type: "string", description: "Workspace root override. Defaults to the session root." },
    },
    required: ["role", "provider", "model"],
  },
  timeoutMs: 60000,
  retryable: false,
  execute: async (input: unknown) => {
    const args = asStringRecord(input) ?? {};
    const rawRole = optionalString(args, "role") ?? "";
    if (!(ROLE_ORDER as readonly string[]).includes(rawRole)) {
      return { ok: false, error: `unknown role "${rawRole}" — one of: ${ROLE_ORDER.join(", ")}` };
    }
    const role = rawRole as RoleId;
    const providerId = optionalString(args, "provider") ?? "";
    const modelId = optionalString(args, "model") ?? "";
    if (!providerId || !modelId) return { ok: false, error: "provider and model are both required" };
    const slot = optionalString(args, "slot") === "backup" ? "backup" : "primary";
    if (slot === "backup" && !optionalString(args, "human_backup_authorization")) {
      return { ok: false, error: "slot=backup requires human_backup_authorization with the Human's exact words" };
    }
    // Validate against the real catalog (plus live subscription proxies for openai-compatible).
    const { ids } = await catalogModels(providerId);
    const known = new Set(ids);
    if (providerId === "openai-compatible") {
      for (const id of await liveGrokModels()) known.add(id);
      for (const id of await liveAntigravityModels()) known.add(id);
    }
    if (known.size && ![...known].some((id) => id === modelId)) {
      return {
        ok: false,
        error: `model "${modelId}" not in the ${providerId} catalog (${known.size} models). Call workflow_models to browse exact ids.`,
      };
    }
    const file = rolesFileFor(optionalString(args, "project"));
    const { table } = loadRoles(optionalString(args, "project"));
    const nextRoute = { providerId, modelId };
    const levelRaw = optionalString(args, "reasoning") ?? "";
    const level = levelRaw.toLowerCase();
    if (level === "low" || level === "medium" || level === "high" || level === "xhigh") {
      (nextRoute as { reasoning?: string }).reasoning = level;
    }
    table[role][slot] = nextRoute;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeRoles({ table, updatedRole: role }));
    return {
      ok: true,
      role,
      slot,
      route: `${providerId}/${modelId}`,
      file,
      validated: known.size > 0,
      note:
        slot === "backup"
          ? "Backup stored. It still needs explicit Human words at each USE — storing is not authorizing."
          : "Primary live for the next fresh spawn. No session restart needed.",
    };
  },
});

export const pickerTools = [workflowProviders, workflowModels, workflowPick];
