// [+pavan] WorkflowBoardPane — mission-control board as a native Desktop view.
//
// Data sources (all existing upstream seams, zero new transport):
// - Workspace files: sidecar fs via desktopClient? NO — upstream has no
//   generic read-file command. Instead the pane shells to the bundled
//   .pavan board renderer through the chat bash tool? NO — simpler:
//   the pane reads via the same hub session files the CLI reads.
//   v1: workspace path from historyWorkspacePaths + Tauri read via
//   desktop sidecar `read_session_messages`? NO.
//   v1 decision: use Tauri `pick_workspace_directory`-adjacent fs through
//   the sidecar's existing workspace discovery? NO new commands.
//
// Honest v1: the pane receives `workspace` (active thread's path) and reads
// STATE.yaml/STEPS.md/roles through a tiny [+pavan] sidecar command
// `pavan_read_workspace_file` (added in sidecar/commands-pavan.ts).
// Until that command lands, props.readFile injects the reader (tests +
// web-mode fallback), so the pane renders with injected data.
// - Sessions: useSessionHistory result passed from page.tsx (existing).
// - Providers/models: fetchProviderCatalog/loadProviderModels from
//   lib/provider-model-catalog (existing bus, cached, invalidated).
// Roles save: writes roles file via sidecar command `pavan_write_roles`
// (same file the plugin tools read). No providers.json touched.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchProviderCatalog,
  loadProviderModels,
} from "@/lib/provider-model-catalog";
import {
	isRouteReady,
	parseDecisionsTail,
	parseRolesYaml,
	parseWorkflowMetrics,
	parseWorkflowState,
	parseWorkflowSteps,
	type WorkflowMainState,
	type WorkflowMetricTail,
	type WorkflowStepCard,
} from "./board-parsers";

export const WORKFLOW_ROLE_IDS = [
  "coder",
  "reviewer",
  "tester",
  "architect",
  "security",
  "design_advisor",
  "designer",
] as const;

/** Reasoning effort per role. Пусто = None (без thinking). */
export const WORKFLOW_REASONING_LEVELS = ["", "low", "minimal", "medium", "high", "xhigh", "max"] as const;

export const WORKFLOW_ROLE_RU: Record<string, { name: string; hint: string }> = {
  coder: { name: "Код", hint: "пишет код по шагу" },
  reviewer: { name: "Проверка", hint: "независимая проверка (другая модель!)" },
  tester: { name: "Тесты", hint: "запускает тесты, добавляет падающие" },
  architect: { name: "Архитектура", hint: "вторая голова при неясном дизайне" },
  security: { name: "Безопасность", hint: "аудит перед релизом" },
  design_advisor: { name: "Дизайн-совет", hint: "советы по интерфейсу текстом" },
  designer: { name: "Дизайн", hint: "правит интерфейс руками" },
};

export interface PavanFileReader {
  readFile: (absPath: string) => Promise<string | null>;
  writeFile: (absPath: string, content: string) => Promise<void>;
}

export interface WorkflowBoardSnapshot {
  state: WorkflowMainState | null;
  steps: WorkflowStepCard[];
  roles: Record<string, { primary: string; backup: string; primaryReasoning?: string; backupReasoning?: string }>;
  metrics: WorkflowMetricTail;
  decisions: string;
  generatedAt: string;
}

export function useWorkflowBoard(
  workspace: string,
  io: PavanFileReader,
): {
  snapshot: WorkflowBoardSnapshot | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  saveRole: (role: string, provider: string, model: string, reasoning?: string) => Promise<{ ok: boolean; error?: string }>;
} {
  const [snapshot, setSnapshot] = useState<WorkflowBoardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setLoading(true);
    const root = workspace.replace(/\/$/, "");
    (async () => {
      try {
        const [stateRaw, stepsRaw, rolesRaw, metricsRaw, decisionsRaw] = await Promise.all([
          io.readFile(`${root}/AI_Workflow_Kit/docs/AI/STATE.yaml`),
          io.readFile(`${root}/AI_Workflow_Kit/docs/STEPS.md`),
          io.readFile(`${root}/.cline/workflow-roles.yaml`),
          io.readFile(`${root}/AI_Workflow_Kit/docs/AI/metrics.jsonl`),
          io.readFile(`${root}/AI_Workflow_Kit/docs/DECISIONS.md`),
        ]);
        if (cancelled) return;
        if (!stateRaw && !stepsRaw) {
          setError("В этой папке нет воркфлоу-кита — открой проект с AI_Workflow_Kit/");
          setSnapshot(null);
          return;
        }
        setError(null);
        setSnapshot({
          state: stateRaw ? parseWorkflowState(stateRaw) : null,
          steps: parseWorkflowSteps(stepsRaw ?? ""),
          roles: parseRolesYaml(rolesRaw ?? "", [...WORKFLOW_ROLE_IDS]).table,
          metrics: parseWorkflowMetrics(metricsRaw ?? ""),
          decisions: parseDecisionsTail(decisionsRaw ?? ""),
          generatedAt: new Date().toLocaleString("ru-RU"),
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace, io, tick]);

  const saveRole = useCallback(
    async (role: string, provider: string, model: string, reasoning?: string) => {
      if (!WORKFLOW_ROLE_IDS.includes(role as (typeof WORKFLOW_ROLE_IDS)[number])) {
        return { ok: false, error: "неизвестная роль" };
      }
      if (!provider || !model) return { ok: false, error: "нужны и провайдер, и модель" };
      try {
        const current = snapshot?.roles ?? {};
        const lines = [
          "# Маршруты ролей — правит пульт. Руками тоже можно.",
          "# Пусто = роль заблокирована, тихой подмены нет.",
          "",
          "version: 1",
          "",
          "policy:",
          "  automatic_backup: false",
          "  require_human_backup_authorization: true",
          "",
          "roles:",
        ];
        const normReasoning = (v: unknown): string =>
          v === "low" || v === "medium" || v === "high" || v === "xhigh" || v === "max" || v === "minimal" ? (v as string) : "";
        for (const r of WORKFLOW_ROLE_IDS) {
          const entry = r === role
            ? {
                primary: `${provider}/${model}`,
                backup: current[r]?.backup ?? "",
                reasoning: normReasoning(reasoning),
              }
            : {
                primary: current[r]?.primary ?? "",
                backup: current[r]?.backup ?? "",
                reasoning: normReasoning((current[r] as { primaryReasoning?: unknown })?.primaryReasoning),
              };
          const split = (x: string): { provider: string; model: string } => {
            if (!x) return { provider: "", model: "" };
            const i = x.indexOf("/");
            return i < 0 ? { provider: x, model: "" } : { provider: x.slice(0, i), model: x.slice(i + 1) };
          };
          const p = split(entry.primary);
          const b = split(entry.backup);
          const rs = normReasoning((entry as { reasoning?: unknown }).reasoning);
          const rsPart = rs ? `, reasoning: "${rs}"` : "";
          lines.push(`  ${r}:`);
          lines.push(`    primary: { provider: "${p.provider}", model: "${p.model}"${rsPart}}`);
          lines.push(`    backup: { provider: "${b.provider}", model: "${b.model}" }`);
          lines.push("");
        }
        await io.writeFile(`${workspace.replace(/\/$/, "")}/.cline/workflow-roles.yaml`, lines.join("\n"));
        reload();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [snapshot, workspace, io, reload],
  );

  return useMemo(
    () => ({ snapshot, loading, error, reload, saveRole }),
    [snapshot, loading, error, reload, saveRole],
  );
}

export function WorkflowBoardPane(props: {
  workspace: string;
  io: PavanFileReader;
  onOpenProviders?: () => void;
}): JSX.Element {
  const { snapshot, loading, error, reload, saveRole } = useWorkflowBoard(props.workspace, props.io);
  const [providers, setProviders] = useState<Array<{ id: string; name: string; configured: boolean }>>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, Array<{ id: string; efforts: string[] }>>>({});
  const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const [pick, setPick] = useState<Record<string, { provider: string; model: string; reasoning?: string }>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetchProviderCatalog()
      .then((payload) => {
        if (cancelled) return;
        setProviders(
          (payload.providers ?? []).map((p) => ({
            id: p.id,
            name: p.name ?? p.id,
            configured: Boolean((p as { configured?: boolean }).configured),
          })),
        );
      })
      .catch((e) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = snapshot?.state?.current_step || "(нет)";
  const readyCount = snapshot
    ? WORKFLOW_ROLE_IDS.filter((r) => isRouteReady(snapshot.roles[r]?.primary ?? "")).length
    : 0;

  const effortsOf = (m: { reasoningOptions?: Array<{ type?: string; values?: Array<string | null> }> }): string[] => {
    const eff = (m.reasoningOptions ?? []).find((o) => o?.type === "effort");
    const vals = Array.isArray(eff?.values) ? eff.values.filter((v): v is string => typeof v === "string") : [];
    return vals.filter((v) => (EFFORT_ORDER as readonly string[]).includes(v));
  };
  const loadModels = useCallback(
    async (provider: string) => {
      if (!provider || modelsByProvider[provider]) return;
      try {
        const models = await loadProviderModels(provider);
        setModelsByProvider((m) => ({
          ...m,
          [provider]: models.map((x) => ({ id: x.id, efforts: effortsOf(x as never) })),
        }));
      } catch {
        // row keeps guidance; catalog error surfaces once at top
      }
    },
    [modelsByProvider],
  );

  const onSave = useCallback(
    async (role: string) => {
      const sel = pick[role];
      if (!sel?.provider || !sel?.model) {
        setStatus((s) => ({ ...s, [role]: "сначала выбери провайдера и модель" }));
        return;
      }
      setSaving((s) => ({ ...s, [role]: true }));
      const r = await saveRole(role, sel.provider, sel.model, sel.reasoning);
      setSaving((s) => ({ ...s, [role]: false }));
      setStatus((s) => ({
        ...s,
        [role]: r.ok
          ? `✓ ${sel.provider}/${sel.model}${sel.reasoning ? `:${sel.reasoning}` : ""} — активно`
          : (r.error ?? "не сохранилось"),
      }));
    },
    [pick, saveRole],
  );

  return (
    <div data-pavan="workflow-board" className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold">Пульт воркфлоу</h2>
        <span className="rounded-full bg-amber-400 px-3 py-0.5 text-xs font-bold text-black">Шаг {live}</span>
        <span className="text-xs text-muted-foreground">Роли {readyCount}/7</span>
        <span className="text-xs text-muted-foreground" title="Сессия — это Main. Маршруты ролей ниже применяются только к свежим воркерам.">
          Оркестратор: эта сессия
        </span>
        <button type="button" onClick={reload} className="ml-auto rounded-lg border px-3 py-1 text-xs">
          Обновить
        </button>
      </div>
      {catalogError && (
        <p className="mb-2 text-xs text-red-500">
          Каталог провайдеров недоступен: {catalogError}{" "}
          {props.onOpenProviders && (
            <button type="button" className="underline" onClick={props.onOpenProviders}>
              Открыть провайдеры
            </button>
          )}
        </p>
      )}
      {loading && <p className="text-sm text-muted-foreground">Читаю STATE.yaml / STEPS.md…</p>}
      {error && <p className="text-sm text-red-500">{error}</p>}
      {snapshot?.state && (
        <div className="mb-3 grid grid-cols-2 gap-2 text-[13px] md:grid-cols-4">
          <div>
            Работа: <strong>{snapshot.state.status || "?"}</strong>
          </div>
          <div>Провалов подряд: {snapshot.state.repeated_failure_count || "0"}/3</div>
          <div>Проверка: {snapshot.state.verdict || "?"}</div>
          <div>
            Профиль: {snapshot.state.pipeline_profile || "?"}
            {snapshot.state.quick_forbidden === "true" ? " · быстрый ЗАПРЕЩЁН" : ""}
          </div>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <section>
          <h3 className="mb-1 text-sm font-semibold">Шаги ({snapshot?.steps.length ?? 0})</h3>
          {(snapshot?.steps ?? []).map((c) => (
            <article key={c.id} className={`mb-2 rounded-xl border p-3 ${c.id === live ? "border-amber-400" : ""}`}>
              <header className="text-[13px]">
                {c.id === live && <span className="mr-1 font-bold text-amber-400">● сейчас</span>}
                <strong>{c.id}</strong> · {c.title} <span className="text-muted-foreground">· {c.done}/{c.total}</span>
              </header>
              <div className="my-1 h-1.5 rounded bg-black/30">
                <div
                  className="h-full rounded bg-amber-400"
                  style={{ width: `${c.total ? Math.round((c.done / c.total) * 100) : 0}%` }}
                />
              </div>
              {(["do", "objective", "judgment"] as const).map((kind) => {
                const list = c.items.filter((it) => it.kind === kind);
                if (!list.length) return null;
                const title = kind === "do" ? "Дела" : kind === "objective" ? "Проверки (команды)" : "Проверки (смысл)";
                return (
                  <div key={kind}>
                    <div className="mt-1 text-xs text-muted-foreground">{title}</div>
                    <ul className="m-0 list-none p-0 text-[13px]">
                      {list.map((it) => (
                        <li key={it.id || it.text} className="flex gap-2 py-0.5">
                          <span>{it.done ? "✓" : "○"}</span>
                          {it.id && <code className="text-xs">{it.id}</code>}
                          <span>{it.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </article>
          ))}
        </section>
        <section>
          <h3 className="mb-1 text-sm font-semibold">Роли {readyCount}/7</h3>
          {WORKFLOW_ROLE_IDS.map((r) => {
            const cur = snapshot?.roles[r]?.primary ?? "";
            const curReasoning = snapshot?.roles[r]?.primaryReasoning ?? "";
            const sel = pick[r] ?? { provider: cur.split("/")[0] ?? "", model: "", reasoning: curReasoning };
            const models = modelsByProvider[sel.provider] ?? [];
            const selEfforts =
              models.find((m) => m.id === sel.model)?.efforts ??
              [...new Set(models.flatMap((m) => m.efforts))];
            return (
              <div key={r} className="mb-2 grid grid-cols-[110px_1fr_1fr_110px_auto] items-center gap-2 rounded-xl border p-2">
                <div>
                  <strong className="block text-[13px]">{WORKFLOW_ROLE_RU[r].name}</strong>
                  <span className="block text-[11px] text-muted-foreground">{WORKFLOW_ROLE_RU[r].hint}</span>
                </div>
                <select
                  aria-label={`${r} provider`}
                  value={sel.provider}
                  onChange={(e) => {
                    const provider = e.target.value;
                    setPick((p) => ({ ...p, [r]: { provider, model: "", reasoning: p[r]?.reasoning } }));
                    if (provider) void loadModels(provider);
                  }}
                  className="rounded-lg border bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">— провайдер —</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                      {p.configured ? " ✓" : ""}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`${r} model`}
                  value={sel.model}
                  disabled={!sel.provider || !models.length}
                  onChange={(e) => {
                    const model = e.target.value;
                    const effs = models.find((m) => m.id === model)?.efforts ?? [];
                    setPick((p) => {
                      const cur = p[r]?.reasoning;
                      const keep = cur && (effs.length === 0 || effs.includes(cur)) ? cur : undefined;
                      return { ...p, [r]: { ...p[r], provider: sel.provider, model, reasoning: keep } };
                    });
                  }}
                  className="rounded-lg border bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">— модель —</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {m.efforts.length ? "" : " (без reasoning)"}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`${r} reasoning effort`}
                  value={sel.reasoning ?? ""}
                  title="Глубина рассуждений (thinking). Пусто = None."
                  onChange={(e) => setPick((p) => ({ ...p, [r]: { ...p[r], provider: sel.provider, model: sel.model, reasoning: e.target.value || undefined } }))}
                  className="rounded-lg border bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">— усилие —</option>
                  {(sel.model ? selEfforts : [...new Set(models.flatMap((m) => m.efforts))]).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void onSave(r)}
                  disabled={!!saving[r]}
                  className="rounded-lg bg-amber-400 px-3 py-1 text-xs font-bold text-black"
                >
                  {saving[r] ? "…" : "Сохранить"}
                </button>
                <span className="col-span-5 text-[11px] text-muted-foreground">
                  {status[r] ?? ((cur ? `${cur}${curReasoning ? `:${curReasoning}` : ""}` : "") || "не назначена — запуск заблокирован")}
                </span>
              </div>
            );
          })}
          <h3 className="mb-1 mt-4 text-sm font-semibold">
            Запуски <span className="font-normal text-muted-foreground">— пассивные, на роутинг не влияют</span>
          </h3>
          <div className="rounded-xl border p-2 text-[13px]">
            <div className="flex flex-wrap gap-1">
              {Object.entries(snapshot?.metrics.byStatus ?? {}).length
                ? Object.entries(snapshot?.metrics.byStatus ?? {}).map(([s, n]) => (
                    <span key={s} className="rounded-full border px-2 py-0.5 text-[11px]">
                      {s} × {n}
                    </span>
                  ))
                : <span className="text-muted-foreground">запусков пока не было</span>}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{snapshot?.metrics.events ?? 0} событий</div>
            {(snapshot?.metrics.last ?? []).map((e, i) => (
              <div key={`${e.status}-${i}`} className="text-[12px]">
                {e.step ? `${e.step} · ` : ""}{e.role ? `${e.role} · ` : ""}{e.status}
              </div>
            ))}
          </div>
          <h3 className="mb-1 mt-4 text-sm font-semibold">
            Решения <span className="font-normal text-muted-foreground">— хвост</span>
          </h3>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border p-2 text-[11px]">
            {snapshot?.decisions || "(DECISIONS.md пока нет)"}
          </pre>
        </section>
      </div>
    </div>
  );
}
