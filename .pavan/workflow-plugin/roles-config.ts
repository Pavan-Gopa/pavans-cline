// roles-config.ts — role routes live OUTSIDE the plugin package.
//
// Lookup order (first hit wins):
//   1. <workspace>/.cline/workflow-roles.yaml   (project file — commit it)
//   2. ~/.cline/workflow-roles.yaml             (global fallback)
//   3. bundled assets/roles.example.yaml        (all empty → every spawn blocked)
//
// Format: see assets/roles.example.yaml. Keep the parser dependency-free
// (indented `key: value` + `{ provider, model }` inline maps only).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "./project-roots";
import { ROLE_ORDER, type ModelRoute, type RoleId } from "./roles";

export const PROJECT_ROLES_FILE = ".cline/workflow-roles.yaml";
export const GLOBAL_ROLES_FILE = join(homedir(), ".cline", "workflow-roles.yaml");

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface RoleEntry {
  primary: ModelRoute;
  backup: ModelRoute;
}

export type RolesTable = Record<RoleId, RoleEntry>;

export interface RolesLoadResult {
  table: RolesTable;
  source: string;
}

function emptyTable(): RolesTable {
  const table = {} as RolesTable;
  for (const role of ROLE_ORDER) table[role] = { primary: { providerId: "", modelId: "" }, backup: { providerId: "", modelId: "" } };
  return table;
}

function inlineRoute(text: string): ModelRoute | undefined {
	const provider = /provider:\s*"([^"]*)"|provider:\s*'([^']*)'|provider:\s*([^\s,}]+)/.exec(text);
	const model = /model:\s*"([^"]*)"|model:\s*'([^']*)'|model:\s*([^\s,}]+)/.exec(text);
	const reasoning = /reasoning:\s*"([^"]*)"|reasoning:\s*'([^']*)'|reasoning:\s*([^\s,}]+)/.exec(text);
	const pick = (m: RegExpExecArray | null) => (m ? (m[1] ?? m[2] ?? m[3] ?? "") : "");
	if (!provider && !model && !reasoning) return undefined;
	const route: ModelRoute = { providerId: pick(provider), modelId: pick(model) };
	const level = pick(reasoning).toLowerCase();
	if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max" || level === "minimal") route.reasoning = level;
	return route;
}

/** Minimal parser for the roles file shape only — not a YAML library. */
export function parseRolesYaml(text: string): RolesTable {
  const table = emptyTable();
  const lines = text.split("\n");
  let role: RoleId | null = null;
  let slot: "primary" | "backup" | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const roleMatch = /^  ([a-z_]+):\s*$/.exec(line);
    if (roleMatch && (ROLE_ORDER as readonly string[]).includes(roleMatch[1])) {
      role = roleMatch[1] as RoleId;
      slot = null;
      continue;
    }
    if (!role) continue;
    const slotMatch = /^    (primary|backup):\s*(\{.*\})?\s*$/.exec(line);
    if (slotMatch) {
      const inline = slotMatch[2] ? inlineRoute(slotMatch[2]) : undefined;
      if (inline) table[role][slotMatch[1] as "primary" | "backup"] = inline;
      slot = slotMatch[1] as "primary" | "backup";
      continue;
    }
    const kvMatch = /^      (provider|model|reasoning):\s*(.+?)\s*$/.exec(line);
    if (kvMatch && slot) {
      const value = kvMatch[2].replace(/^['"]|['"]$/g, "").trim();
      if (kvMatch[1] === "provider") table[role][slot].providerId = value;
      else if (kvMatch[1] === "model") table[role][slot].modelId = value;
      else {
        const level = value.toLowerCase();
        if (level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max" || level === "minimal") table[role][slot].reasoning = level;
        else delete table[role][slot].reasoning;
      }
    }
  }
  return table;
}

export function candidateRolesFiles(projectRoot?: string): string[] {
  const root = projectRoot ?? resolveProjectRoot();
  return [
    join(root, PROJECT_ROLES_FILE),
    GLOBAL_ROLES_FILE,
    join(MODULE_DIR, "..", "assets", "roles.example.yaml"),
  ];
}

export function loadRoles(projectRoot?: string): RolesLoadResult {
  for (const file of candidateRolesFiles(projectRoot)) {
    try {
      if (!existsSync(file)) continue;
      const table = parseRolesYaml(readFileSync(file, "utf8"));
      return { table, source: file };
    } catch {
      continue;
    }
  }
  return { table: emptyTable(), source: "(none — all empty)" };
}

/** Resolve a spawn route: explicit args win, else primary/backup from file. */
export function resolveRoute(
  table: RolesTable,
  role: RoleId,
  args: { providerId?: string; modelId?: string; reasoning?: string; isBackup?: boolean },
): ModelRoute {
  const level = (args.reasoning ?? "").toLowerCase();
  const override =
    level === "low" || level === "medium" || level === "high" || level === "xhigh" || level === "max" || level === "minimal"
      ? level
      : "";
  if (args.providerId || args.modelId) {
    const route: ModelRoute = { providerId: args.providerId ?? "", modelId: args.modelId ?? "" };
    if (override) route.reasoning = override;
    return route;
  }
  const entry = table[role];
  const base = args.isBackup ? { ...entry.backup } : { ...entry.primary };
  if (override) base.reasoning = override;
  return base;
}

export function configuredRoleCount(table: RolesTable): { primary: number; backup: number } {
  let primary = 0;
  let backup = 0;
  for (const role of ROLE_ORDER) {
    if (table[role].primary.providerId && table[role].primary.modelId) primary += 1;
    if (table[role].backup.providerId && table[role].backup.modelId) backup += 1;
  }
  return { primary, backup };
}
