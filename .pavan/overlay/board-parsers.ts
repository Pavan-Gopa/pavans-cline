// [+pavan] Workflow board parsers — TS port of .pavan/board/dashboard.mjs.
//
// Same line-oriented parsers (no YAML dep): STATE.yaml scan, STEPS.md cards
// with loose ## Verification attached to the last card, metrics.jsonl tail.
// dashboard.mjs remains the reference implementation; this module mirrors it
// for the React pane. Behavior contract is pinned by board-parsers.test.

export interface WorkflowGateItem {
  done: boolean;
  id: string;
  text: string;
  kind: "do" | "objective" | "judgment";
}

export interface WorkflowStepCard {
  id: string;
  title: string;
  profile: string;
  risk: string;
  items: WorkflowGateItem[];
  done: number;
  total: number;
}

export interface WorkflowMainState {
  current_step: string;
  current_work_item_id: string;
  current_work_item: string;
  status: string;
  attempts: string;
  repeated_failure_count: string;
  last_failure_signature: string;
  blocker: string;
  verdict: string;
  bugs_open: string;
  pipeline_profile: string;
  quick_forbidden: string;
  security_next: string;
  next_actor: string;
  completed_steps: string[];
  skipped_steps: string[];
  target_files: string[];
}

function scalar(value: string): string {
  return value
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s+#.*$/, "")
    .trim();
}

function listAfter(text: string, key: string): string[] {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (m) items.push(m[1]);
    else if (line.trim() && !/^\s/.test(line)) break;
  }
  return items.slice(0, 20);
}

export function parseWorkflowState(text: string): WorkflowMainState {
  const get = (key: string): string => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(text ?? "");
    return m ? scalar(m[1]) : "";
  };
  return {
    current_step: get("current_step"),
    current_work_item_id: get("current_work_item_id"),
    current_work_item: get("current_work_item"),
    status: get("status"),
    attempts: get("attempts"),
    repeated_failure_count: get("repeated_failure_count"),
    last_failure_signature: get("last_failure_signature"),
    blocker: get("blocker"),
    verdict: get("verdict"),
    bugs_open: get("bugs_open"),
    pipeline_profile: get("profile"),
    quick_forbidden: get("quick_forbidden"),
    security_next: get("next_run"),
    next_actor: get("next_actor"),
    completed_steps: listAfter(text, "completed_steps"),
    skipped_steps: listAfter(text, "skipped_steps"),
    target_files: listAfter(text, "target_files"),
  };
}

function cardItems(full: string): WorkflowGateItem[] {
  const items: WorkflowGateItem[] = [];
  for (const m of full.matchAll(
    /^\s*[-*]\s*\[([ xX])\]\s*(?:\[([^\]]+)\]\s*)?(.+?)\s*$/gm,
  )) {
    const before = full.slice(0, m.index);
    const h = [...before.matchAll(/^(?:#{3,}|\*\*(.+?):\*\*)\s*(.+?)?$/gm)].pop();
    const name = (h?.[1] ?? h?.[2] ?? "").toLowerCase();
    if (/out of scope|ready for|stop-gate/.test(name)) continue;
    const kind: WorkflowGateItem["kind"] = /objective/.test(name)
      ? "objective"
      : /judgment/.test(name)
        ? "judgment"
        : "do";
    items.push({
      done: m[1].toLowerCase() === "x",
      id: m[2] ?? "",
      text: m[3].slice(0, 160),
      kind,
    });
  }
  return items;
}

export function parseWorkflowSteps(text: string): WorkflowStepCard[] {
  const cards: WorkflowStepCard[] = [];
  if (!text) return cards;
  const headings = [
    ...text.matchAll(
      /^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)(?:[ \t]+[—-][ \t]+(.+?))?\s*$/gm,
    ),
  ];
  let pendingVerif = "";
  const flush = (id: string, title: string, body: string): void => {
    if (/^verification$/i.test(id)) {
      const last = cards[cards.length - 1];
      if (last) {
        const extra = cardItems(body);
        last.items.push(...extra);
        last.done = last.items.filter((it) => it.done).length;
        last.total = last.items.length;
      } else pendingVerif += `\n${body}`;
      return;
    }
    if (/^(how)$/i.test(id) || !title || title.includes("_")) return;
    const full = `${pendingVerif}\n${body}`;
    pendingVerif = "";
    const profile =
      (/^\*\*Pipeline profile:\*\*\s*(\w+)/m.exec(full) ?? [])[1] ?? "standard";
    const risk = (/^\*\*Risk:\*\*\s*(\w+)/m.exec(full) ?? [])[1] ?? "";
    const items = cardItems(full);
    cards.push({
      id,
      title,
      profile,
      risk,
      items,
      done: items.filter((it) => it.done).length,
      total: items.length,
    });
  };
  for (let i = 0; i < headings.length; i += 1) {
    const start = (headings[i].index ?? 0) + headings[i][0].length;
    const end =
      i + 1 < headings.length ? (headings[i + 1].index ?? text.length) : text.length;
    flush(headings[i][1], (headings[i][2] ?? "").trim(), text.slice(start, end));
  }
  return cards;
}

export interface WorkflowRoleRoute {
  primary: string;
  backup: string;
  /** Reasoning effort for the primary slot ("low"|"medium"|"high"|"xhigh" or absent). */
  primaryReasoning?: string;
  backupReasoning?: string;
}

export function parseRolesYaml(
  text: string,
  order: string[],
): { table: Record<string, WorkflowRoleRoute>; source: string } {
  const table: Record<string, WorkflowRoleRoute> = {};
  for (const role of order) table[role] = { primary: "", backup: "" };
  if (!text) return { table, source: "" };
  let role: string | null = null;
  let slot: "primary" | "backup" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;
    const rm = /^  ([a-z_]+):\s*$/.exec(line);
    if (rm && order.includes(rm[1])) {
      role = rm[1];
      slot = null;
      continue;
    }
    if (!role) continue;
    const sm = /^    (primary|backup):\s*(\{.*\})?\s*$/.exec(line);
    if (sm) {
      slot = sm[1] as "primary" | "backup";
      if (sm[2]) {
        const p =
          /provider:\s*"([^"]*)"|provider:\s*'([^']*)'|provider:\s*([^\s,}]+)/.exec(sm[2]);
        const m =
          /model:\s*"([^"]*)"|model:\s*'([^']*)'|model:\s*([^\s,}]+)/.exec(sm[2]);
        const q =
          /reasoning:\s*"([^"]*)"|reasoning:\s*'([^']*)'|reasoning:\s*([^\s,}]+)/.exec(sm[2]);
        const val = (x: RegExpExecArray | null): string =>
          x ? (x[1] ?? x[2] ?? x[3] ?? "") : "";
        const provider = val(p);
        const model = val(m);
        const level = val(q).toLowerCase();
        const reasoning = level === "low" || level === "medium" || level === "high" || level === "xhigh" ? level : "";
        if (provider || model)
          table[role][slot] = `${provider}/${model}`
            .replace(/^\//, "")
            .replace(/\/$/, "");
        if (reasoning) {
          if (slot === "primary") table[role].primaryReasoning = reasoning;
          else table[role].backupReasoning = reasoning;
        }
      }
      continue;
    }
    const km = /^      (provider|model|reasoning):\s*(.+?)\s*$/.exec(line);
    if (km && slot) {
      const value = km[2].replace(/^['"]|['"]$/g, "").trim();
      if (km[1] === "reasoning") {
        const level = value.toLowerCase();
        if (slot === "primary") {
          if (level === "low" || level === "medium" || level === "high" || level === "xhigh") table[role].primaryReasoning = level;
          else delete table[role].primaryReasoning;
        } else if (level === "low" || level === "medium" || level === "high" || level === "xhigh") table[role].backupReasoning = level;
        else delete table[role].backupReasoning;
        continue;
      }
      const cur = table[role][slot] ? table[role][slot].split("/") : ["", ""];
      if (km[1] === "provider") cur[0] = value;
      else cur[1] = value;
      table[role][slot] = `${cur[0]}/${cur[1]}`
        .replace(/^\//, "")
        .replace(/\/$/, "");
    }
  }
  return { table, source: "roles.yaml" };
}

export function isRouteReady(route: string): boolean {
  return route.includes("/") && !route.startsWith("/") && !route.endsWith("/");
}
