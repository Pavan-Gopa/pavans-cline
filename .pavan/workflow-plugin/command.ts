// /workflow slash command — port of `.omp/commands/workflow.md` (v3.4.x).
//
// The handler returns routing guidance text; the model then invokes the real
// tools (workflow_status, workflow_gates_run, workflow_security_scope).
// It never mutates state itself: Main owns transitions after verification.

export function handleWorkflowCommand(rawInput: string): string {
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean);
  const verb = (tokens[0] ?? "help").toLowerCase();
  const rest = tokens.slice(1).join(" ");

  switch (verb) {
    case "help":
    case "":
      return [
        "/workflow <verb>: start | status | next <instruction> | why | metrics | roles | pick <role> | designer advise <surface> | designer redesign <surface> | update",
        "- start/status: call workflow_status, reconcile STATE.yaml + active STEPS.md card + git diff, preserve partial work.",
        "- next: targeted reconciliation first (active step, changed files, gate evidence), then ONE fresh specialist.",
        "- why: derive the routing reason from real state and evidence, not from history.",
        "- metrics: call workflow_metrics_report (passive; never gates routing).",
        "- roles: call workflow_roles and show the role→route table (Alt+M view).",
        "- pick <role>: interactive assignment (Alt+M flow): workflow_providers → ask Human → workflow_models → ask Human → workflow_pick.",
        "- designer: advisory or implementation ONLY on explicit Human visual feedback; never automatic.",
      ].join("\n");
    case "roles":
      return [
        "Call workflow_roles and present the table: per-role primary/backup route, source file, N/7 spawn-ready.",
        "For any unconfigured role the Human cares about, offer: `/workflow pick <role>` — never invent a route.",
      ].join("\n");
    case "pick": {
      const role = rest.split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!["coder", "reviewer", "tester", "architect", "security", "design_advisor", "designer"].includes(role)) {
        return "Usage: /workflow pick <role> — role is one of: coder, reviewer, tester, architect, security, design_advisor, designer.";
      }
      return [
        `Interactive assignment for role "${role}" (Alt+M flow, Human picks at each step):`,
        `1. Call workflow_providers. Show a numbered list: configured providers first (marked), then catalog matches. Ask the Human for the provider number or id.`,
        `2. Call workflow_models with the chosen provider. Show a numbered list (mark live Grok proxy models when present). Ask the Human for the model number or id.`,
        `3. Call workflow_pick with role="${role}", chosen provider+model. Report the saved route + file. Primary is live immediately.`,
        "For a backup slot instead, ask for the Human's exact authorizing words first, then workflow_pick with slot=backup + human_backup_authorization.",
        "Never choose for the Human; never write providers.json. Only the project .cline/workflow-roles.yaml changes.",
      ].join("\n");
    }
    case "start":
    case "status":
    case "ready":
      return [
        "1. Call workflow_status. 2. Read STATE.yaml current_step + active STEPS.md card.",
        "3. Reconcile with the git diff (preserve partial work; disappearance is not a product failure).",
        "4. If onboarding incomplete, validate role routes before dispatching workers.",
        "5. Report: current step, work item, pending gates, proposed next worker. Do not dispatch inside status.",
      ].join("\n");
    case "next":
      return [
        `Human instruction: ${rest || "(none given — ask for it if the next step is ambiguous)"}`,
        "1. Targeted reconciliation: STATE.yaml, active card, changed files, gate evidence.",
        "2. Dispatch exactly ONE fresh specialist with a compact packet (goal, step, stable ID, target/allowed paths, exclusions, Objective + Judgment gates, verified retry facts).",
        "3. After return: verify against real source/diff/tests FIRST (workflow_gates_run + workflow_security_scope on Coder diffs), then update state, then route.",
      ].join("\n");
    case "why":
      return [
        "Derive the current routing reason from: STATE.yaml current_step/work item, active card checkboxes,",
        "last verified gate evidence, last worker result + your verification. State the next justified stage",
        "or the exact blocker. One paragraph, no transcript quotes.",
      ].join("\n");
    case "metrics":
      return "Call workflow_metrics_report and summarize by status/profile. Metrics are passive evidence, never a routing input. Never invent token costs.";
    case "update":
      return [
        "Framework update is a Human-confirmed maintenance action, not product routing.",
        "Diff this plugin package against the upstream workflow contract, preserve live project memory",
        "(STATE.yaml, STEPS.md, DECISIONS.md, model assignments), then tell the Human to restart the session.",
        "Do not continue product routing in the same command after an applied update.",
      ].join("\n");
    case "designer":
      if (/^advise\b/i.test(rest)) {
        return [
          `Build an advisory packet for surface: ${rest.replace(/^advise\s+/i, "") || "(unspecified — ask)"}`,
          "Dispatch the design_advisor role read-only (Human feedback verbatim, target surface, preserve-list, source paths, cost boundary).",
          "Verify the brief for specificity, then route to ordinary Coder -> Reviewer -> Tester -> Human visual acceptance.",
        ].join("\n");
      }
      if (/^redesign\b/i.test(rest)) {
        return [
          `Confirm FIRST: exact presentation-layer target_files + preserve-list for: ${rest.replace(/^redesign\s+/i, "") || "(unspecified — ask)"}`,
          "Only then dispatch designer in implementation mode. Verify diff + visual artifacts, then Reviewer + Tester + Human visual acceptance (accepted | changes_requested with exact feedback).",
        ].join("\n");
      }
      return "Usage: /workflow designer advise <surface> | /workflow designer redesign <surface>. If advisory vs direct editing is unclear, ask one concise question — never spend the Designer route automatically.";
    default:
      return `Unknown /workflow verb "${verb}". Treating the whole input as a Human instruction: reconcile state (workflow_status), then route ONE fresh specialist. Input: ${rawInput}`;
  }
}
