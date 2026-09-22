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
  parseRolesYaml,
  parseWorkflowState,
  parseWorkflowSteps,
  type WorkflowMainState,
  type WorkflowStepCard,
} from "../../../../.pavan/overlay/board-parsers";

export const WORKFLOW_ROLE_IDS = [
  "coder",
  "reviewer",
  "tester",
  "architect",
  "security",
  "design_advisor",
  "designer",
] as const;

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
  roles: Record<string, { primary: string; backup: string }>;
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
  saveRole: (role: string, provider: string, model: string) => Promise<{ ok: boolean; error?: string }>;
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
        const [stateRaw, stepsRaw, rolesRaw] = await Promise.all([
          io.readFile(`${root}/AI_Workflow_Kit/docs/AI/STATE.yaml`),
          io.readFile(`${root}/AI_Workflow_Kit/docs/STEPS.md`),
          io.readFile(`${root}/.cline/workflow-roles.yaml`),
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
    async (role: string, provider: string, model: string) => {
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
        for (const r of WORKFLOW_ROLE_IDS) {
          const entry = r === role
            ? { primary: `${provider}/${model}`, backup: current[r]?.backup ?? "" }
            : (current[r] ?? { primary: "", backup: "" });
          const split = (s: string): { provider: string; model: string } => {
            if (!s) return { provider: "", model: "" };
            const i = s.indexOf("/");
            return i < 0 ? { provider: s, model: "" } : { provider: s.slice(0, i), model: s.slice(i + 1) };
          };
          const p = split(entry.primary);
          const b = split(entry.backup);
          lines.push(`  ${r}:`);
          lines.push(`    primary: { provider: "${p.provider}", model: "${p.model}" }`);
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
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [pick, setPick] = useState<Record<string, { provider: string; model: string }>>({});
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

  const loadModels = useCallback(
    async (provider: string) => {
      if (!provider || modelsByProvider[provider]) return;
      try {
        const models = await loadProviderModels(provider);
        setModelsByProvider((m) => ({ ...m, [provider]: models.map((x) => x.id) }));
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
      const r = await saveRole(role, sel.provider, sel.model);
      setSaving((s) => ({ ...s, [role]: false }));
      setStatus((s) => ({
        ...s,
        [role]: r.ok ? `✓ ${sel.provider}/${sel.model} — активно` : (r.error ?? "не сохранилось"),
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
            const sel = pick[r] ?? { provider: cur.split("/")[0] ?? "", model: "" };
            const models = modelsByProvider[sel.provider] ?? [];
            return (
              <div key={r} className="mb-2 grid grid-cols-[110px_1fr_1fr_auto] items-center gap-2 rounded-xl border p-2">
                <div>
                  <strong className="block text-[13px]">{WORKFLOW_ROLE_RU[r].name}</strong>
                  <span className="block text-[11px] text-muted-foreground">{WORKFLOW_ROLE_RU[r].hint}</span>
                </div>
                <select
                  aria-label={`${r} provider`}
                  value={sel.provider}
                  onChange={(e) => {
                    const provider = e.target.value;
                    setPick((p) => ({ ...p, [r]: { provider, model: "" } }));
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
                  onChange={(e) => setPick((p) => ({ ...p, [r]: { provider: sel.provider, model: e.target.value } }))}
                  className="rounded-lg border bg-transparent px-2 py-1 text-xs"
                >
                  <option value="">— модель —</option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
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
                <span className="col-span-4 text-[11px] text-muted-foreground">
                  {status[r] ?? (cur || "не назначена — запуск заблокирован")}
                </span>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
