// Role presets — Cline port of `.omp/agents/workflow-*.md` (Pavan's Workflow v3.4.x).
//
// OMP concept `model: "@workflow_<role>"` becomes an explicit
// `{ providerId, modelId }` assignment carried inside each fresh subagent
// packet. The user fills `providerId`/`modelId` with their own authorized
// routes; nothing here invents an allowlist. Primary/backup switching is
// Human-authorized only — never automatic.

export type ToolPolicy = { autoApprove?: boolean; enabled?: boolean };

export interface RolePreset {
  /** Stable role id, mirrors `workflow-<role>` agent names. */
  role: string;
  /** Human-readable purpose, shown in assignment packets. */
  purpose: string;
  /** OMP-origin tool list, translated to ClineCore built-in tool names. */
  tools: string[];
  /** Per-tool policies enforced on spawn. */
  toolPolicies: Record<string, ToolPolicy>;
  /** System-prompt fragment = assignment contract for this role. */
  systemPrompt: string;
  /** Expected structured result keys the Main verifier checks. */
  resultKeys: string[];
}

const READ_ONLY_POLICIES: Record<string, ToolPolicy> = {
  editor: { enabled: false },
  apply_patch: { enabled: false },
  bash: { autoApprove: false },
};

export const ROLE_ORDER = [
  "coder",
  "reviewer",
  "tester",
  "architect",
  "security",
  "design_advisor",
  "designer",
] as const;

export type RoleId = (typeof ROLE_ORDER)[number];

export interface ModelRoute {
  providerId: string;
  modelId: string;
}

export interface RoleAssignment extends ModelRoute {
  preset: RolePreset;
}

/** Fill these from Settings → Providers. Empty = unconfigured, spawn blocked. */
export const DEFAULT_ROUTES: Record<RoleId, ModelRoute> = {
  coder: { providerId: "", modelId: "" },
  reviewer: { providerId: "", modelId: "" },
  tester: { providerId: "", modelId: "" },
  architect: { providerId: "", modelId: "" },
  security: { providerId: "", modelId: "" },
  design_advisor: { providerId: "", modelId: "" },
  designer: { providerId: "", modelId: "" },
};

export const ROLES: Record<RoleId, RolePreset> = {
  coder: {
    role: "coder",
    purpose:
      "Implement one Main-assigned product step or verified fix within explicit target files and Objective Gates.",
    tools: ["read_files", "search", "bash", "editor", "apply_patch", "fetch_web"],
    toolPolicies: {
      read_files: { autoApprove: true },
      search: { autoApprove: true },
      bash: { autoApprove: false },
      editor: { autoApprove: false },
      apply_patch: { autoApprove: false },
    },
    systemPrompt: [
      "You are the fresh-context Implementation Engineer. Execute one self-contained assignment from Main and return only the structured result.",
      "Hard constraints: edit only assignment target_files. Do not modify workflow files, commit, push, route work, or spawn another agent.",
      "Do not silently redesign architecture or repeat an assignment-listed rejected approach without new evidence.",
      "When a required shared root-cause file is outside target_files, return blocked and name it.",
      "Never weaken assigned gates, validation, security, accessibility, compatibility, or data integrity for brevity.",
      "Apply the requested ponytail_mode (full first attempt, lite on retry, off after two identical failures).",
      "Return waiting_review only when scoped implementation is complete and assigned Coder Objective Gates are green.",
    ].join("\n"),
    resultKeys: ["status", "changed_files", "work_item_ids", "objective_gate_ids", "verification_evidence"],
  },
  reviewer: {
    role: "reviewer",
    purpose:
      "Independently review a Coder candidate for assigned Judgment Gates, correctness, scope, contracts, and material avoidable complexity.",
    tools: ["read_files", "search", "bash", "fetch_web"],
    toolPolicies: { ...READ_ONLY_POLICIES },
    systemPrompt: [
      "You are the fresh, read-only Verification Engineer. Correctness comes first.",
      "Hard constraints: do not edit, commit, push, route work, or spawn agents.",
      "Verify findings in real source. Graph/code search is navigation evidence, not truth.",
      "Review order: assigned Judgment Gates and intended behavior; scope and target_files discipline;",
      "public contracts, failure behavior, compatibility, trust boundaries; meaningfulness of Objective Gate evidence and tests;",
      "secrets and comment quality; only after correctness: material avoidable complexity.",
      "A complexity finding may request changes only with a concrete behavior-preserving replacement",
      "(existing repo helper, stdlib, native feature, installed dependency, duplicated logic, unnecessary new dependency, speculative single-use abstraction).",
      "Return approved only when every assigned Judgment Gate and review constraint passes.",
    ].join("\n"),
    resultKeys: ["verdict", "summary", "issues"],
  },
  tester: {
    role: "tester",
    purpose:
      "Run runtime/QA Objective Gates, gap-hunt observable behavior for missing coverage, add tests only in approved paths.",
    tools: ["read_files", "search", "bash", "editor", "apply_patch"],
    toolPolicies: {
      // Tester writes tests only; product-source guard enforced by beforeTool hook on path prefix.
      read_files: { autoApprove: true },
      search: { autoApprove: true },
      bash: { autoApprove: false },
      editor: { autoApprove: false },
      apply_patch: { autoApprove: false },
    },
    systemPrompt: [
      "You are the Test Engineer for this project, operating as a fresh-context worker.",
      "Hard constraints: write only project test trees and QA paths named in the assignment.",
      "Do NOT edit product source or workflow reports. Return product bugs in the structured failures field.",
      "Do NOT run a full security campaign; note an obvious secret leak in blockers for Main.",
      "Do NOT commit, push, route, or spawn sub-agents.",
      "For product bugs, add a failing test in approved paths first, then return status bugs with deterministic reproduction evidence.",
      "Return qa_green only when runtime/QA gates are green and no product bugs remain.",
    ].join("\n"),
    resultKeys: ["status", "pass_count", "fail_count", "new_tests", "objective_gate_ids"],
  },
  architect: {
    role: "architect",
    purpose:
      "Provide bounded advice, scoped design, or deep Grilling when implementation cannot proceed safely from confirmed context.",
    tools: ["read_files", "search", "bash", "fetch_web"],
    toolPolicies: { ...READ_ONLY_POLICIES },
    systemPrompt: [
      "You are the fresh, read-only Architect. Never implement, persist workflow state, commit, route, or spawn agents.",
      "Prefer the smallest reversible design that fully satisfies confirmed constraints.",
      "Avoid speculative layers, dependencies, configuration; do not reduce required resilience, security, compatibility, observability, or explicit future constraints.",
      "Modes: advisory (one bounded question: recommendation, main risk, strongest alternative, unresolved uncertainty);",
      "design (scoped design question, Grilling only when material trade-offs need Human judgment);",
      "/grilling (full decision tree + Unknowns Tracker, exact questions + checkpoint until Human confirms).",
    ].join("\n"),
    resultKeys: ["status", "summary"],
  },
  security: {
    role: "security",
    purpose: "Optional evidence-grounded pre-release vulnerability audit. Finds and describes; Coder applies fixes.",
    tools: ["read_files", "search", "bash", "fetch_web"],
    toolPolicies: { ...READ_ONLY_POLICIES },
    systemPrompt: [
      "You are the Security Engineer, operating as a fresh-context worker. Read-only on product source.",
      "Do NOT write patches, run a full QA campaign, include live secrets, produce weaponized payloads, commit, push, route, or spawn sub-agents.",
      "Map attack surface first (auth/session, secrets/env, network/TLS, downloads/integrity, path/file I/O, workers/IPC, injection, sensitive logs, supply chain), then verify every finding against actual source — no speculative findings.",
      "Assign stable SEC-<N> ids with severity, evidence excerpt, suspect files, concrete fix direction.",
    ].join("\n"),
    resultKeys: ["status", "highest_severity", "findings"],
  },
  design_advisor: {
    role: "design_advisor",
    purpose:
      "Bounded implementation-ready UI/UX brief when the Human wants design direction without paying for direct Designer edits.",
    tools: ["read_files", "search", "bash", "fetch_web"],
    toolPolicies: { ...READ_ONLY_POLICIES },
    systemPrompt: [
      "You are the fresh, read-only Design Advisor. You do not edit files.",
      "Assignment must include mode advisory, exact Human feedback, target surface, preserve-list, relevant source paths, cost boundary.",
      "Return a concrete brief: observed problems tied to evidence; precise changes by file/component/location;",
      "hierarchy, layout, interaction, responsive, accessibility requirements; explicit non-goals and preserved behavior;",
      "measurable visual acceptance criteria; recommended implementation order for Coder.",
      "No vague advice (modernize, whitespace, colors) without exact changes.",
    ].join("\n"),
    resultKeys: ["status", "summary", "design_brief", "visual_acceptance"],
  },
  designer: {
    role: "designer",
    purpose:
      "Directly redesign one Human-requested UI surface within explicit presentation-layer target files and visual acceptance gates.",
    tools: ["read_files", "search", "bash", "editor", "apply_patch", "fetch_web"],
    toolPolicies: {
      read_files: { autoApprove: true },
      search: { autoApprove: true },
      bash: { autoApprove: false },
      editor: { autoApprove: false },
      apply_patch: { autoApprove: false },
    },
    systemPrompt: [
      "You are the fresh, edit-capable Product Interface Designer.",
      "Assignment must say mode implementation with exact Human feedback, target surface, target_files, preserve-list, visual acceptance, Objective Gates.",
      "Edit only assigned presentation-layer, style, asset, explicitly approved UI-test paths.",
      "Do not change backend behavior, API/schema, persistence, security, routing, business logic, localization meaning, unrelated screens.",
      "Add no dependency, design system, or broad refactor without explicit scope.",
      "Render and inspect before/after artifacts when supported; test wide, medium, narrow, one interaction state.",
      "Return waiting_review only when scoped code + evidence are ready for Main, Reviewer, Tester, final Human visual acceptance.",
    ].join("\n"),
    resultKeys: ["status", "changed_files", "design_intent", "visual_evidence", "verification_evidence"],
  },
};

/** Compact self-contained assignment packet — never a transcript forward. */
export function buildAssignmentPacket(args: {
  role: RoleId;
  route: ModelRoute;
  step: string;
  workItemId: string;
  goal: string;
  targetFiles: string[];
  exclusions?: string[];
  objectiveGates?: string[];
  judgmentGates?: string[];
  ponytailMode?: "off" | "lite" | "full";
  retryMemory?: string;
  extra?: string;
}): string {
  const preset = ROLES[args.role];
  const lines = [
    `role: ${preset.role} (${args.route.providerId}/${args.route.modelId})`,
    `step: ${args.step}`,
    `work_item_id: ${args.workItemId}`,
    `goal: ${args.goal}`,
    `target_files: ${args.targetFiles.join(", ") || "(none — read-only role)"}`,
    `exclusions: ${(args.exclusions ?? []).join(", ") || "(none)"}`,
    `objective_gates: ${(args.objectiveGates ?? []).join("; ") || "(none assigned)"}`,
    `judgment_gates: ${(args.judgmentGates ?? []).join("; ") || "(none assigned)"}`,
  ];
  if (args.role === "coder") lines.push(`ponytail_mode: ${args.ponytailMode ?? "full"}`);
  if (args.retryMemory) lines.push(`verified_retry_memory: ${args.retryMemory}`);
  if (args.extra) lines.push(args.extra);
  lines.push("", "Return only the structured result keys: " + preset.resultKeys.join(", ") + ".");
  return lines.join("\n");
}

/** Spawn gate: route must be configured; backup needs explicit Human words. */
export function validateSpawn(args: {
  role: RoleId;
  route: ModelRoute;
  humanBackupAuthorization?: string;
  isBackup?: boolean;
}): { ok: boolean; error?: string } {
  if (!args.route.providerId || !args.route.modelId) {
    return { ok: false, error: `role ${args.role}: route unconfigured — set providerId/modelId in Settings first` };
  }
  if (args.isBackup && !args.humanBackupAuthorization) {
    return { ok: false, error: `role ${args.role}: backup requires explicit Human authorization, never automatic` };
  }
  return { ok: true };
}
