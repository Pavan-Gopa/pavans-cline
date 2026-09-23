// [+pavan] Roles section — Alt+M: role→route assignment with live pickers.
//
// Same data as the Workflow board Roles panel, surfaced natively in
// Settings: provider ▾ → model ▾ → Save per role, backed by the live
// provider catalog (fetchProviderCatalog/loadProviderModels bus) and the
// same roles file the board + plugin tools read (.cline/workflow-roles.yaml
// via pavan sidecar commands). Writes touch ONLY that file — never
// providers.json. Backup slots stay Human-words-only (chat /workflow pick).
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { desktopClient } from "@/lib/desktop-client";
import {
  fetchProviderCatalog,
  loadProviderModels,
} from "@/lib/provider-model-catalog";
import type { Provider } from "@/lib/provider-schema";

export const WORKFLOW_ROLE_IDS = [
  "coder",
  "reviewer",
  "tester",
  "architect",
  "security",
  "design_advisor",
  "designer",
] as const;

export type WorkflowRoleId = (typeof WORKFLOW_ROLE_IDS)[number];

const ROLE_META: Record<WorkflowRoleId, { name: string; hint: string }> = {
  coder: { name: "Код", hint: "пишет код по шагу" },
  reviewer: { name: "Проверка", hint: "независимая проверка (другая модель!)" },
  tester: { name: "Тесты", hint: "запускает тесты, добавляет падающие" },
  architect: { name: "Архитектура", hint: "вторая голова при неясном дизайне" },
  security: { name: "Безопасность", hint: "аудит перед релизом" },
  design_advisor: { name: "Дизайн-совет", hint: "советы по интерфейсу текстом" },
  designer: { name: "Дизайн", hint: "правит интерфейс руками" },
};

function normReasoning(v: unknown): string {
  const level = String(v ?? "").toLowerCase();
  return ["low", "minimal", "medium", "high", "xhigh", "max"].includes(level) ? level : "";
}
function splitRoute(route: string): { provider: string; model: string } {
  if (!route) return { provider: "", model: "" };
  const i = route.indexOf("/");
  return i < 0 ? { provider: route, model: "" } : { provider: route.slice(0, i), model: route.slice(i + 1) };
}

function isReady(route: string): boolean {
  return route.includes("/") && !route.startsWith("/") && !route.endsWith("/");
}

export function RolesContent(props: { workspace?: string }): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, { primary: string; backup: string; primaryReasoning?: string }>>(() => {
    const t: Record<string, { primary: string; backup: string; primaryReasoning?: string }> = {};
    for (const r of WORKFLOW_ROLE_IDS) t[r] = { primary: "", backup: "" };
    return t;
  });
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, Array<{ id: string; efforts: string[] }>>>({});
  const [pick, setPick] = useState<Record<string, { provider: string; model: string; reasoning?: string }>>({});
  const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetchProviderCatalog({ fresh: true })
      .then((payload) => {
        if (!cancelled) setProviders(payload.providers ?? []);
      })
      .catch((e) => {
        if (!cancelled) setCatalogError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadRoles = useCallback(async () => {
    try {
      const ws = props.workspace;
      const paths = ws
        ? [`${ws.replace(/\/$/, "")}/.cline/workflow-roles.yaml`]
        : [] as string[];
      if (!paths.length) {
        setRolesLoaded(true);
        return;
      }
      const res = await desktopClient.invoke<{ files: Record<string, string | null> }>(
        "pavan_read_workspace_files",
        { paths },
      );
      const raw = res.files[paths[0]];
      if (!raw) {
        setRolesLoaded(true);
        return;
      }
      const table: Record<string, { primary: string; backup: string; primaryReasoning?: string }> = {};
      for (const r of WORKFLOW_ROLE_IDS) table[r] = { primary: "", backup: "" };
      let role: string | null = null;
      let slot: "primary" | "backup" | null = null;
      for (const rawLine of raw.split("\n")) {
        const line = rawLine.replace(/#.*$/, "");
        if (!line.trim()) continue;
        const rm = /^  ([a-z_]+):\s*$/.exec(line);
        if (rm && (WORKFLOW_ROLE_IDS as readonly string[]).includes(rm[1])) {
          role = rm[1];
          slot = null;
          continue;
        }
        if (!role) continue;
        const sm = /^    (primary|backup):\s*(\{.*\})?\s*$/.exec(line);
        if (sm) {
          slot = sm[1] as "primary" | "backup";
          if (sm[2]) {
            const p = /provider:\s*"([^"]*)"|provider:\s*'([^']*)'|provider:\s*([^\s,}]+)/.exec(sm[2]);
            const m = /model:\s*"([^"]*)"|model:\s*'([^']*)'|model:\s*([^\s,}]+)/.exec(sm[2]);
            const q = /reasoning:\s*"([^"]*)"|reasoning:\s*'([^']*)'|reasoning:\s*([^\s,}]+)/.exec(sm[2]);
            const val = (x: RegExpExecArray | null): string => (x ? (x[1] ?? x[2] ?? x[3] ?? "") : "");
            const provider = val(p);
            const model = val(m);
            const level = val(q).toLowerCase();
            const rs = ["low", "minimal", "medium", "high", "xhigh", "max"].includes(level) ? level : "";
            if (provider || model)
              table[role][slot] = `${provider}/${model}`.replace(/^\//, "").replace(/\/$/, "");
            if (rs && slot === "primary") table[role].primaryReasoning = rs;
          }
          continue;
        }
      }
      setRoles(table);
      setRolesLoaded(true);
    } catch {
      setRolesLoaded(true);
    }
  }, [props.workspace]);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const readyCount = useMemo(
    () => WORKFLOW_ROLE_IDS.filter((r) => isReady(roles[r]?.primary ?? "")).length,
    [roles],
  );

  const effortsOf = (m: { reasoningOptions?: Array<{ type?: string; values?: Array<string | null> }> }): string[] => {
    const eff = (m.reasoningOptions ?? []).find((o) => o?.type === "effort");
    const vals = Array.isArray(eff?.values) ? eff.values.filter((v): v is string => typeof v === "string") : [];
    return vals.filter((v) => (EFFORT_ORDER as readonly string[]).includes(v));
  };
  const loadModels = useCallback(
    async (provider: string) => {
      if (!provider) return;
      try {
        const models = await loadProviderModels(provider);
        setModelsByProvider((m) => ({
          ...m,
          [provider]: models.map((x) => ({ id: x.id, efforts: effortsOf(x as never) })),
        }));
      } catch {
        // row keeps guidance
      }
    },
    [],
  );

  const onSave = useCallback(
    async (role: string) => {
      const sel = pick[role];
      if (!sel?.provider || !sel?.model) {
        setStatus((s) => ({ ...s, [role]: "сначала выбери провайдера и модель" }));
        return;
      }
      setSaving((s) => ({ ...s, [role]: true }));
      try {
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
            ? { primary: `${sel.provider}/${sel.model}`, backup: roles[r]?.backup ?? "", reasoning: normReasoning(sel.reasoning) }
            : { primary: roles[r]?.primary ?? "", backup: roles[r]?.backup ?? "", reasoning: normReasoning(roles[r]?.primaryReasoning) };
          const p = splitRoute(entry.primary);
          const b = splitRoute(entry.backup);
          const rs = normReasoning((entry as { reasoning?: unknown }).reasoning);
          const rsPart = rs ? `, reasoning: "${rs}"` : "";
          lines.push(`  ${r}:`);
          lines.push(`    primary: { provider: "${p.provider}", model: "${p.model}"${rsPart}}`);
          lines.push(`    backup: { provider: "${b.provider}", model: "${b.model}" }`);
          lines.push("");
        }
        await desktopClient.invoke("pavan_write_workflow_roles", { content: lines.join("\n") });
        setStatus((s) => ({ ...s, [role]: `✓ ${sel.provider}/${sel.model}${normReasoning(sel.reasoning) ? `:${normReasoning(sel.reasoning)}` : ""} — активно` }));
        await loadRoles();
      } catch (e) {
        setStatus((s) => ({ ...s, [role]: e instanceof Error ? e.message : "не сохранилось" }));
      } finally {
        setSaving((s) => ({ ...s, [role]: false }));
      }
    },
		[pick, roles, loadRoles],
	);

	return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div>
        <h2 className="text-base font-bold">Роли воркфлоу {readyCount}/7</h2>
        <p className="text-xs text-muted-foreground">
          Провайдер → модель → Сохранить. Тот же файл, что читают пульт и плагин. Запасные составы — только твоими
          словами в чате (/workflow pick). Пустая роль = запуск заблокирован, тихой подмены нет.
        </p>
      </div>
      {catalogError && <p className="text-xs text-red-500">Каталог недоступен: {catalogError}</p>}
      {!rolesLoaded && <p className="text-xs text-muted-foreground">Читаю роли…</p>}
      {WORKFLOW_ROLE_IDS.map((r) => {
        const cur = roles[r]?.primary ?? "";
        const curReasoning = roles[r]?.primaryReasoning ?? "";
        const sel = pick[r] ?? { provider: splitRoute(cur).provider, model: "", reasoning: curReasoning };
        const models = modelsByProvider[sel.provider] ?? [];
        const selEfforts =
          models.find((m) => m.id === sel.model)?.efforts ?? [...new Set(models.flatMap((m) => m.efforts))];
        return (
          <div key={r} className="grid grid-cols-[130px_1fr_1fr_110px_auto] items-center gap-2 rounded-xl border p-2">
            <div>
              <strong className="block text-[13px]">{ROLE_META[r].name}</strong>
              <span className="block text-[11px] text-muted-foreground">{ROLE_META[r].hint}</span>
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
                  const curRs = p[r]?.reasoning;
                  const keep = curRs && (effs.length === 0 || effs.includes(curRs)) ? curRs : undefined;
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
              title="Глубина рассуждений. Пусто = None."
              onChange={(e) =>
                setPick((p) => ({
                  ...p,
                  [r]: { ...p[r], provider: sel.provider, model: sel.model, reasoning: e.target.value || undefined },
                }))
              }
              className="rounded-lg border bg-transparent px-2 py-1 text-xs"
            >
              <option value="">— усилие —</option>
              {(sel.model ? selEfforts : [...new Set(models.flatMap((m) => m.efforts))]).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" disabled={!!saving[r]} onClick={() => void onSave(r)}>
              {saving[r] ? "…" : "Сохранить"}
            </Button>
            <span className="col-span-5 text-[11px] text-muted-foreground">
              {status[r] ??
                (cur ? `${cur}${curReasoning ? `:${curReasoning}` : ""}` : "не назначена — запуск заблокирован")}
              {roles[r]?.backup ? ` · запас: ${roles[r].backup}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
