#!/usr/bin/env node
// dashboard.mjs — пульт Pavan's Workflow. Без зависимостей, без вызовов моделей.
//
// Читает те же файлы, что читает Main (STATE.yaml, STEPS.md, DECISIONS.md,
// metrics.jsonl) + `cline history --json`, отдаёт одну страницу.
// В serve-режиме добавляются три API для назначения ролей кликами:
//
//   GET  /api/providers           — живой каталог провайдеров Cline (настроенные первыми)
//   GET  /api/models?provider=ID  — живой каталог моделей (+ Grok/Antigravity с прокси)
//   POST /api/pick                — {role, provider, model} → пишет ТОЛЬКО проектный roles-файл
//
// Использование:
//   node dashboard.mjs --project /path/to/product --serve 8098   # пульт + API
//   node dashboard.mjs --project /path/to/product --out board.html --once
//
// Автообновления страницы НЕТ by design: оно сносило бы открытые дропдауны.
// Кнопка «Обновить» перечитывает файлы; после Save роли страница показывает
// новый роут сразу из ответа, без перезагрузки.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PROJECT_ARG = process.argv.includes("--project") ? resolve(arg("--project", process.cwd())) : "";
const OUT = resolve(arg("--out", join(HERE, "dashboard.html")));
const ONCE = process.argv.includes("--once");
const SERVE_PORT = process.argv.includes("--serve") ? Number(arg("--serve", "8098")) : 0;

// --- состояние пульта: последний проект + недавние (per-machine, не per-project) ---
function boardStateFile() {
  return join(process.env.HOME ?? "~", ".cline", "workflow-board.json");
}
function readBoardState() {
  try {
    return JSON.parse(readFileSync(boardStateFile(), "utf8"));
  } catch {
    return {};
  }
}
function writeBoardState(patch) {
  try {
    const file = boardStateFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...readBoardState(), ...patch }, null, 2));
  } catch { /* пульт работает и без персиста */ }
}
function touchRecent(project) {
  const state = readBoardState();
  const recent = [project, ...((state.recent ?? []).filter((p) => p !== project))].slice(0, 8);
  writeBoardState({ lastProject: project, recent });
}
// Активный проект: флаг --project > сохранённый > "" (лендинг).
function activeProject() {
  if (PROJECT_ARG) return PROJECT_ARG;
  const saved = readBoardState().lastProject ?? "";
  return saved && existsSync(saved) ? saved : "";
}

const ROLE_IDS = ["coder", "reviewer", "tester", "architect", "security", "design_advisor", "designer"];
const ROLE_RU = {
  coder: "Код",
  reviewer: "Проверка",
  tester: "Тесты",
  architect: "Архитектура",
  security: "Безопасность",
  design_advisor: "Дизайн-совет",
  designer: "Дизайн",
};
const ROLE_HINT = {
  coder: "пишет код по шагу",
  reviewer: "независимая проверка (другая модель!)",
  tester: "запускает тесты, добавляет падающие",
  architect: "вторая голова при неясном дизайне",
  security: "аудит перед релизом",
  design_advisor: "советы по интерфейсу текстом",
  designer: "правит интерфейс руками",
};

function readIf(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- STATE.yaml: построчный разбор без YAML-зависимости (ключи вложенные!) ---
function parseState(text) {
  const get = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(text ?? "");
    if (!m) return "";
    return m[1].replace(/^['"]|['"]$/g, "").replace(/\s+#.*$/, "").trim();
  };
  const listAfter = (key) => {
    const lines = (text ?? "").split("\n");
    const start = lines.findIndex((l) => new RegExp(`^\\s*${key}:`).test(l));
    if (start < 0) return [];
    const items = [];
    for (const line of lines.slice(start + 1)) {
      const m = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (m) items.push(m[1]);
      else if (line.trim() && !/^\s/.test(line)) break;
    }
    return items.slice(0, 20);
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
    completed_steps: listAfter("completed_steps"),
    skipped_steps: listAfter("skipped_steps"),
    target_files: listAfter("target_files"),
  };
}
// --- STEPS.md: карточки ## S<n> — <заголовок>. Служебное выкидываем:
// How to write (инструкция), _(title)_ (шаблон), а болтающийся ## Verification
// подклеиваем к ПОСЛЕДНЕЙ карточке (он идёт после неё) + впереди идущий — к следующей.
function cardItems(full) {
  const items = [];
  for (const m of full.matchAll(/^\s*[-*]\s*\[([ xX])\]\s*(?:\[([^\]]+)\]\s*)?(.+?)\s*$/gm)) {
    const before = full.slice(0, m.index);
    const h = [...before.matchAll(/^(?:#{3,}|\*\*(.+?):\*\*)\s*(.+?)?$/gm)].pop();
    const name = ((h?.[1] ?? h?.[2] ?? "")).toLowerCase();
    const kind = /objective/.test(name) ? "objective" : /judgment/.test(name) ? "judgment" : /out of scope|ready for|stop-gate/.test(name) ? "note" : "do";
    if (kind === "note") continue;
    items.push({ done: m[1].toLowerCase() === "x", id: m[2] ?? "", text: m[3].slice(0, 160), kind });
  }
  return items;
}

function parseSteps(text) {
  const cards = [];
  if (!text) return cards;
  const headings = [...text.matchAll(/^##[ \t]+([A-Za-z0-9][A-Za-z0-9._/-]*)(?:[ \t]+[—-][ \t]+(.+?))?\s*$/gm)];
  let pendingVerif = "";
  const flush = (id, title, body) => {
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
    const profile = (/^\*\*Pipeline profile:\*\*\s*(\w+)/m.exec(full) ?? [])[1] ?? "standard";
    const risk = (/^\*\*Risk:\*\*\s*(\w+)/m.exec(full) ?? [])[1] ?? "";
    const items = cardItems(full);
    cards.push({ id, title, profile, risk, items, done: items.filter((it) => it.done).length, total: items.length });
  };
  for (let i = 0; i < headings.length; i += 1) {
    const start = headings[i].index + headings[i][0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    flush(headings[i][1], (headings[i][2] ?? "").trim(), text.slice(start, end));
  }
  return cards;
}

// --- metrics.jsonl: последние события + счётчики ---
function parseMetrics(text) {
  const byStatus = {};
  const last = [];
  if (!text) return { events: 0, byStatus, last };
  let events = 0;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    events += 1;
    try {
      const e = JSON.parse(t);
      const s = typeof e.status === "string" ? e.status : "unknown";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      last.push(e);
    } catch { /* битую строку пропускаем, счёт не теряем */ }
    if (events > 10000) break;
  }
  return { events, byStatus, last: last.slice(-8).reverse() };
}

// --- сессии Cline для этого корня ---
function projectSessions(project) {
  try {
    const raw = execFileSync("cline", ["history", "--json", "--limit", "50"], { encoding: "utf8", timeout: 15000 });
    const rows = JSON.parse(raw);
    const mine = rows.filter((r) => {
      const root = r.workspaceRoot ?? r.cwd ?? "";
      return root && (project === root || project.startsWith(root + "/") || root.startsWith(project + "/"));
    });
    return { ok: true, sessions: mine.slice(0, 12), total: rows.length };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), sessions: [], total: 0 };
  }
}

// --- roles-файл: проектный, иначе глобальный ---
function rolesTable(project) {
  const order = ROLE_IDS;
  const table = {};
  for (const role of order) table[role] = { primary: "", backup: "" };
  const candidates = [
    join(project, ".cline", "workflow-roles.yaml"),
    join(process.env.HOME ?? "~", ".cline", "workflow-roles.yaml"),
  ];
  let source = "";
  for (const file of candidates) {
    const text = readIf(file);
    if (!text) continue;
    let role = null;
    let slot = null;
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
        slot = sm[1];
        if (sm[2]) {
          const p = /provider:\s*"([^"]*)"|provider:\s*'([^']*)'|provider:\s*([^\s,}]+)/.exec(sm[2]);
          const m = /model:\s*"([^"]*)"|model:\s*'([^']*)'|model:\s*([^\s,}]+)/.exec(sm[2]);
          const val = (x) => (x ? (x[1] ?? x[2] ?? x[3] ?? "") : "");
          const provider = val(p);
          const model = val(m);
          if (provider || model) table[role][slot] = `${provider}/${model}`.replace(/^\//, "").replace(/\/$/, "");
        }
        continue;
      }
      const km = /^      (provider|model):\s*(.+?)\s*$/.exec(line);
      if (km && slot) {
        const value = km[2].replace(/^['"]|['"]$/g, "").trim();
        const cur = table[role][slot] ? table[role][slot].split("/") : ["", ""];
        if (km[1] === "provider") cur[0] = value;
        else cur[1] = value;
        table[role][slot] = `${cur[0]}/${cur[1]}`.replace(/^\//, "").replace(/\/$/, "");
      }
    }
    source = file;
    break;
  }
  return { table, source, order };
}

function gitBrief(project) {
  try {
    const status = execFileSync("git", ["-C", project, "status", "--short"], { encoding: "utf8", timeout: 10000 });
    const branch = execFileSync("git", ["-C", project, "branch", "--show-current"], { encoding: "utf8", timeout: 10000 }).trim();
    return { ok: true, branch, status: status.trim() || "(чисто)" };
  } catch {
    return { ok: false, branch: "", status: "(не git-репозиторий)" };
  }
}

function readyRoute(route) {
  return route.includes("/") && !route.startsWith("/") && !route.endsWith("/");
}

function render({ project, state, steps, metrics, sessions, roles, git, generatedAt }) {
  const live = state.current_step || "(нет)";
  const shortProject = project.split("/").slice(-2).join("/");

  const stepCards = steps.map((c) => {
    const isLive = c.id === live;
    const groups = { do: [], objective: [], judgment: [] };
    for (const it of c.items) (groups[it.kind] ?? groups.do).push(it);
    const box = (it) => {
      const cls = it.done ? "done" : (state.current_work_item_id && it.id === state.current_work_item_id ? "active" : "");
      const mark = it.done ? "✓" : "○";
      return `<li class="gate ${cls}"><span class="mark">${mark}</span><code>${esc(it.id)}</code><span>${esc(it.text)}</span></li>`;
    };
    const sec = (title, list) => list.length
      ? `<div class="gates-title">${title}</div><ul class="gates">${list.map(box).join("")}</ul>`
      : "";
    return `<section class="card${isLive ? " live" : ""}">
      <header>${isLive ? `<span class="live">● сейчас</span>` : ""}
      <strong>${esc(c.id)}</strong> · ${esc(c.title)}
      <span class="dim">${esc(c.profile)}${c.risk ? ` · риск ${esc(c.risk)}` : ""} · ${c.done}/${c.total}</span></header>
      <div class="bar"><i style="width:${c.total ? Math.round((c.done / c.total) * 100) : 0}%"></i></div>
      ${sec("Дела", groups.do)}${sec("Проверки (команды)", groups.objective)}${sec("Проверки (смысл)", groups.judgment)}</section>`;
  }).join("\n");

  const metricChips = Object.entries(metrics.byStatus).map(([s, n]) => `<span class="chip">${esc(s)} × ${n}</span>`).join(" ") || `<span class="dim">запусков пока не было</span>`;
  const metricRows = metrics.last.map((e) =>
    `<div class="line"><code>${esc((e.ts ?? "").slice(11, 19))}</code><span>${esc(e.status ?? "?")}</span><span class="dim">итераций ${esc(String(e.iterations ?? "?"))}</span></div>`,
  ).join("");

  const sessionRows = sessions.sessions.map((s) => {
    const liveMark = !s.endedAt ? ` <span class="live">● идёт</span>` : "";
    return `<div class="line"><code>${esc((s.sessionId ?? "").slice(-12))}</code><span>${esc(s.status)}${liveMark}</span><span class="dim">${esc(s.provider ?? "")} / ${esc(s.model ?? "")}</span></div>
    <div class="dim prompt">${esc((s.prompt ?? "").replace(/<[^>]*>/g, " ").slice(0, 160))}</div>`;
  }).join("") || `<div class="dim">сессий Cline для этой папки пока нет — открой её в Cline Desktop</div>`;

  const roleRows = roles.order.map((r) => {
    const entry = roles.table[r];
    const cur = readyRoute(entry.primary) ? entry.primary : "";
    const [curProvider, curModel] = cur ? cur.split("/") : ["", ""];
    const backup = entry.backup || "";
    return `<div class="prow" data-role="${r}" data-provider="${esc(curProvider)}" data-model="${esc(curModel)}">`
      + `<div class="rname"><strong>${esc(ROLE_RU[r] ?? r)}</strong><span class="dim">${esc(ROLE_HINT[r] ?? "")}</span></div>`
      + `<select class="pprov" aria-label="${r}: провайдер"><option value="">— провайдер —</option></select>`
      + `<select class="pmodel" aria-label="${r}: модель" disabled><option value="">— модель —</option></select>`
      + `<button class="psave" type="button">Сохранить</button>`
      + `<span class="pstat dim">${cur ? esc(cur) : "не назначена — запуск заблокирован"}${backup ? ` · запас: ${esc(backup)}` : ""}</span></div>`;
  }).join("");
  const readyCount = roles.order.filter((r) => readyRoute(roles.table[r].primary)).length;

  const decisions = readIf(join(project, "AI_Workflow_Kit", "docs", "DECISIONS.md"));
  const decisionsTail = decisions ? esc(decisions.split("\n").slice(-12).join("\n")) : "(DECISIONS.md пока нет)";

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Воркфлоу ${esc(live)} — ${esc(shortProject)}</title>
<style>
:root{
  --bg:#16130e; --panel:#201c14; --line:#3a3325; --ink:#f2ead8; --dim:#a89c80;
  --gold:#e0a83c; --gold-ink:#241a05; --green:#7fc97f; --red:#e06c5b; --blue:#7fb3d5;
}
*{box-sizing:border-box}
body{font:14px/1.55 -apple-system,"SF Pro Text",system-ui,sans-serif;background:var(--bg);color:var(--ink);max-width:1060px;margin:0 auto;padding:20px 18px 60px}
h1{font-size:22px;margin:0}
h2{font-size:15px;margin:22px 0 8px;display:flex;gap:8px;align-items:baseline}
.sub{color:var(--dim);font-size:12.5px}
.top{display:flex;gap:14px;align-items:center;flex-wrap:wrap;border-bottom:2px solid var(--gold);padding-bottom:12px}
.top .live-pill{background:var(--gold);color:var(--gold-ink);font-weight:700;border-radius:20px;padding:2px 12px;font-size:13px}
button{font:inherit;cursor:pointer}
.dim{color:var(--dim)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.grid{display:grid;grid-template-columns:7fr 5fr;gap:16px;margin-top:6px}
@media(max-width:860px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:10px 0}
.card.live{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold)}
.card header{font-size:13.5px}
.live{color:var(--gold);font-weight:700;font-size:12px}
.bar{height:6px;background:#00000055;border-radius:3px;margin:8px 0}
.bar i{display:block;height:100%;background:var(--gold);border-radius:3px}
.gates-title{font-size:12px;color:var(--dim);margin:8px 0 2px}
ul.gates{list-style:none;margin:0;padding:0}
.gate{display:flex;gap:8px;align-items:baseline;padding:2px 0;font-size:13px}
.gate .mark{width:16px;text-align:center;color:var(--dim)}
.gate.done{opacity:.62}.gate.done .mark{color:var(--green)}
.gate.active{background:#e0a83c22;border-radius:6px;padding:2px 6px;margin-left:-6px}
.line{display:flex;gap:10px;align-items:baseline;padding:2px 0}
.prompt{margin:0 0 8px 4px;font-size:12px}
.chip{border:1px solid var(--line);border-radius:12px;padding:0 10px;font-size:12px;margin-right:6px}
.prow{display:grid;grid-template-columns:150px 1fr 1fr auto;gap:8px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.prow:first-child{border-top:none}
.rname strong{display:block;font-size:13px}
.rname span{font-size:11.5px}
.prow select{font:inherit;font-size:12.5px;background:#100d08;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:5px 6px;max-width:100%}
.prow select:disabled{opacity:.45}
.psave{background:var(--gold);color:var(--gold-ink);border:none;border-radius:8px;padding:6px 12px;font-weight:600}
.psave:hover{filter:brightness(1.08)}
.pstat{grid-column:1/-1;font-size:11.5px}
.pok{color:var(--green)}.perr{color:var(--red)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:13px}
.kv dt{color:var(--dim)}.kv dd{margin:0}
pre{background:#00000044;border-radius:8px;padding:8px;overflow:auto;max-height:200px;font-size:11.5px;white-space:pre-wrap}
.refresh{margin-left:auto;font-size:12px;background:none;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:4px 10px}
</style></head><body>
<header class="top"><div><h1>Пульт воркфлоу</h1><div class="sub">${esc(shortProject)} · ${esc(project)}</div></div>
<span class="live-pill">Шаг ${esc(live)}</span>
<span class="sub">${esc(state.current_work_item_id || "без активного пункта")} · ${esc(state.pipeline_profile || "?")}${state.quick_forbidden === "true" ? " · быстрый режим ЗАПРЕЩЁН" : ""}</span>
<button class="refresh" type="button" onclick="location.reload()">Обновить</button></header>
<div class="sub">Обновлено ${esc(generatedAt)} · страница сама не перезагружается, чтобы не сносить открытые списки</div>

<div class="grid"><div>
<h2>Состояние <span class="sub">— пишет только Main</span></h2>
<div class="panel"><dl class="kv">
<div style="display:contents"><dt>Работа</dt><dd><strong>${esc(state.status || "?")}</strong> <span class="dim">· попыток ${esc(state.attempts || "0")} · одинаковых провалов ${esc(state.repeated_failure_count || "0")}/3</span></dd></div>
${state.blocker && state.blocker !== "null" ? `<div style="display:contents"><dt>Стопор</dt><dd><strong>${esc(state.blocker)}</strong></dd></div>` : ""}
${state.last_failure_signature && state.last_failure_signature !== "null" ? `<div style="display:contents"><dt>Последний провал</dt><dd class="dim">${esc(state.last_failure_signature)}</dd></div>` : ""}
<div style="display:contents"><dt>Проверка</dt><dd>${esc(state.verdict || "?")} <span class="dim">· багов ${esc(state.bugs_open || "0")}</span></dd></div>
<div style="display:contents"><dt>Безопасность</dt><dd>${esc(state.security_next || "не предлагалась")} <span class="dim">· дальше: ${esc(state.next_actor || "?")}</span></dd></div>
${state.target_files.length ? `<div style="display:contents"><dt>Файлы</dt><dd><code>${state.target_files.map(esc).join("</code>, <code>")}</code></dd></div>` : ""}
${state.completed_steps.length ? `<div style="display:contents"><dt>Готово</dt><dd>${state.completed_steps.map(esc).join(", ")}</dd></div>` : ""}
</dl></div>
<h2>Шаги (${steps.length}) <span class="sub">— текущий подсвечен</span></h2>
${stepCards || '<div class="panel dim">карточек шагов нет</div>'}
</div><div>
<h2>Роли ${readyCount}/7 <span class="sub">— клик и готово</span></h2>
<div class="panel" id="roles">${roleRows}<div class="sub">Провайдер → модель → Сохранить. Тот же файл, что читает плагин — активно сразу. Запасные составы — через <code>/workflow pick</code> (нужны твои слова).</div></div>
<h2>Сессии <span class="sub">— живые помечены ●</span></h2>
<div class="panel">${sessionRows}</div>
<div class="sub">всего в истории: ${sessions.total}${sessions.ok ? "" : ` · ошибка истории: ${esc(sessions.error)}`}</div>
<h2>Запуски <span class="sub">— пассивные, на роутинг не влияют</span></h2>
<div class="panel"><div>${metricChips}</div><div class="sub">${metrics.events} событий</div>${metricRows}</div>
<h2>Git <span class="sub">${esc(git.branch || "?")}</span></h2>
<div class="panel"><pre>${esc(git.status)}</pre></div>
<h2>Решения <span class="sub">— хвост</span></h2>
<div class="panel"><pre>${decisionsTail}</pre></div>
</div></div>
<script>
(function(){
  var panel = document.getElementById('roles');
  if (!panel) return;
  function opt(v, sel){ return '<option value="'+String(v).replace(/"/g,'&quot;')+'"'+(v===sel?' selected':'')+'>'+String(v)+'</option>'; }
  function failAll(msg){
    panel.querySelectorAll('.pstat').forEach(function(s){ s.textContent = msg; s.className = 'pstat perr'; });
  }
  fetch('api/providers').then(function(r){
    if (!r.ok) throw new Error('providers ' + r.status);
    return r.json();
  }).then(function(d){
    var list = (d.providers || []).slice().sort(function(a,b){
      return ((b.configured?1:0)-(a.configured?1:0)) || (a.id < b.id ? -1 : 1);
    });
    if (!list.length) { failAll('каталог провайдеров пуст — проверь установку Cline'); return; }
    panel.querySelectorAll('.prow').forEach(function(row){
      var cur = row.getAttribute('data-provider') || '';
      var sel = row.querySelector('.pprov');
      var known = list.some(function(p){ return p.id === cur; });
      sel.innerHTML = '<option value="">— провайдер —</option>' + list.map(function(p){
        return opt(p.id + (p.configured ? ' ✓' : ''), '');
      }).join('');
      // Проставляем текущий: ищем option по id (без галочки).
      Array.prototype.forEach.call(sel.options, function(o){ if (o.value.replace(/ ✓$/,'') === cur) { o.selected = true; o.value = cur; } });
      if (cur && !known) {
        var o = document.createElement('option'); o.value = cur; o.textContent = cur + ' (нет в каталоге)'; o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', function(){
        sel.value = sel.value.replace(/ ✓$/, '');
        var msel = row.querySelector('.pmodel');
        var stat = row.querySelector('.pstat');
        msel.disabled = true;
        msel.innerHTML = '<option>загружаю…</option>';
        if (!sel.value) { msel.innerHTML = '<option value="">— модель —</option>'; return; }
        fetch('api/models?provider='+encodeURIComponent(sel.value)).then(function(r){
          if (!r.ok) throw new Error('models ' + r.status);
          return r.json();
        }).then(function(md){
          var curM = row.getAttribute('data-model') || '';
          var sameProv = (row.getAttribute('data-provider') || '') === sel.value;
          msel.innerHTML = '<option value="">— модель —</option>' + (md.models || []).map(function(m){ return opt(m, sameProv ? curM : ''); }).join('');
          msel.disabled = false;
          var n = (md.models || []).length;
          stat.textContent = n ? ('моделей: ' + n + (md.live_grok_models ? ' (+' + md.live_grok_models + ' живых Grok)' : '') + (md.live_antigravity_models ? ' (+' + md.live_antigravity_models + ' живых Antigravity)' : '')) : 'у провайдера нет моделей в каталоге';
          stat.className = 'pstat dim';
        }).catch(function(){ stat.textContent = 'не загрузились модели — проверь соединение и прокси'; stat.className = 'pstat perr'; });
      });
      if (cur) sel.dispatchEvent(new Event('change'));
      row.querySelector('.psave').addEventListener('click', function(){
        var stat = row.querySelector('.pstat');
        var msel = row.querySelector('.pmodel');
        if (!sel.value || !msel.value) { stat.textContent = 'сначала выбери провайдера и модель'; stat.className = 'pstat perr'; return; }
        stat.textContent = 'сохраняю…'; stat.className = 'pstat dim';
        fetch('api/pick', { method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ role: row.getAttribute('data-role'), provider: sel.value, model: msel.value })
        }).then(function(r){ return r.json().then(function(pd){ return { status: r.status, body: pd }; }); }).then(function(out){
          var pd = out.body;
          if (pd.ok) {
            row.setAttribute('data-provider', sel.value);
            row.setAttribute('data-model', msel.value);
            stat.textContent = '✓ ' + pd.route + ' — активно';
            stat.className = 'pstat pok';
          } else { stat.textContent = pd.error || ('ошибка ' + out.status); stat.className = 'pstat perr'; }
        }).catch(function(){ stat.textContent = 'не сохранилось — глянь лог сервера'; stat.className = 'pstat perr'; });
      });
    });
  }).catch(function(){ failAll('каталог недоступен — запущен ли борд через --serve? открой http://127.0.0.1:8098/, а не файл'); });
})();
</script>
</body></html>`;
}

// --- serve-API: провайдеры / модели / назначение ---------------------------
let clineLibs = null;
async function libs() {
  if (!clineLibs) {
    clineLibs = await import(join(HERE, "..", "node_modules", "@cline", "core", "dist", "index.js"));
  }
  return clineLibs;
}

async function apiProviders(query) {
  const { Llms, ProviderSettingsManager } = await libs();
  const q = (query ?? "").toLowerCase();
  const all = await Llms.getAllProviders();
  let configured = [];
  try {
    configured = Object.keys(new ProviderSettingsManager().read().providers ?? {});
  } catch { /* считаем все ненастроенными */ }
  const set = new Set(configured);
  const rows = all
    .filter((p) => !q || p.id.toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q))
    .map((p) => ({ id: p.id, name: p.name ?? p.id, configured: set.has(p.id) }))
    .sort((a, b) => Number(b.configured) - Number(a.configured) || (a.id < b.id ? -1 : 1));
  return { ok: true, providers: rows.slice(0, 226), configured_count: configured.length };
}

async function liveProxyModels(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const payload = await res.json();
    const list = Array.isArray(payload?.data) ? payload.data : [];
    return list.map((m) => m?.id).filter((id) => typeof id === "string");
  } catch {
    return [];
  }
}

async function apiModels(providerId, query) {
  if (!providerId) return { ok: false, error: "нужен провайдер", models: [] };
  const { Llms } = await libs();
  const record = await Llms.getModelsForProvider(providerId).catch(() => ({}));
  const ids = new Set(Object.keys(record ?? {}));
  let liveGrok = [];
  let liveAntigravity = [];
  if (providerId === "openai-compatible") {
    liveGrok = await liveProxyModels(8099);
    liveAntigravity = await liveProxyModels(8097);
    for (const id of liveGrok) ids.add(id);
    for (const id of liveAntigravity) ids.add(id);
  }
  const q = (query ?? "").toLowerCase();
  const models = [...ids].filter((id) => !q || id.toLowerCase().includes(q)).sort();
  return { ok: true, provider: providerId, models, count: models.length, live_grok_models: liveGrok.length, live_antigravity_models: liveAntigravity.length };
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) {
        req.destroy();
        rejectPromise(new Error("body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        rejectPromise(new Error("invalid JSON"));
      }
    });
    req.on("error", rejectPromise);
  });
}

function serializeRolesTable(table) {
  const split = (s) => {
    if (!s) return { provider: "", model: "" };
    const i = s.indexOf("/");
    return i < 0 ? { provider: s, model: "" } : { provider: s.slice(0, i), model: s.slice(i + 1) };
  };
  const lines = [
    "# Маршруты ролей — правит пульт / `workflow_pick`. Руками тоже можно.",
    "# Пусто = роль заблокирована, тихой подмены нет.",
    "# Запасные составы — только твоими словами при каждом использовании.",
    "",
    "version: 1",
    "",
    "policy:",
    "  automatic_backup: false",
    "  require_human_backup_authorization: true",
    "",
    "roles:",
  ];
  for (const role of ROLE_IDS) {
    const entry = table[role] ?? { primary: "", backup: "" };
    const toStr = (v) => (typeof v === "string" ? v : `${v?.providerId ?? ""}/${v?.modelId ?? ""}`.replace(/^\//, "").replace(/\/$/, ""));
    const p = split(toStr(entry.primary));
    const b = split(toStr(entry.backup));
    lines.push(`  ${role}:`);
    lines.push(`    primary: { provider: "${p.provider}", model: "${p.model}" }`);
    lines.push(`    backup: { provider: "${b.provider}", model: "${b.model}" }`);
    lines.push("");
  }
  return lines.join("\n");
}

async function apiPick(project, body) {
  const role = body?.role;
  const providerId = body?.provider;
  const modelId = body?.model;
  if (!ROLE_IDS.includes(role)) return { ok: false, error: `неизвестная роль — одна из: ${ROLE_IDS.join(", ")}` };
  if (!providerId || !modelId) return { ok: false, error: "нужны и провайдер, и модель" };
  const { Llms } = await libs();
  const record = await Llms.getModelsForProvider(providerId).catch(() => ({}));
  const known = new Set(Object.keys(record ?? {}));
  if (providerId === "openai-compatible") {
    for (const id of await liveProxyModels(8099)) known.add(id);
    for (const id of await liveProxyModels(8097)) known.add(id);
  }
  if (known.size && ![...known].some((id) => id === modelId)) {
    return { ok: false, error: `модели "${modelId}" нет в каталоге ${providerId} — выбери точный id из списка` };
  }
  const current = rolesTable(project);
  const table = {};
  for (const r of ROLE_IDS) table[r] = current.table[r] ?? { primary: "", backup: "" };
  const cur = table[role];
  const curBackup = typeof cur.backup === "string" ? cur.backup : "";
  table[role] = { primary: `${providerId}/${modelId}`, backup: curBackup };
  const { mkdirSync: mk, writeFileSync: wr } = await import("node:fs");
  const file = join(project, ".cline", "workflow-roles.yaml");
  mk(dirname(file), { recursive: true });
  wr(file, serializeRolesTable(table));
  return { ok: true, role, route: `${providerId}/${modelId}`, file, validated: known.size > 0 };
}

// --- ленивое поселение проекта (первое открытие в пульте, не раньше) ---
function kitTemplate() {
  if (process.env.WF_KIT_SRC && existsSync(process.env.WF_KIT_SRC)) return process.env.WF_KIT_SRC;
  return join(process.env.HOME ?? "~", "Documents", "AI Projects", "Pavan's Workflow", "AI_Workflow_Kit");
}
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    const st = statSync(s);
    if (st.isDirectory()) copyDir(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}
function ensureProject(project) {
  if (existsSync(join(project, "AI_Workflow_Kit", "docs", "AI", "STATE.yaml")) || existsSync(join(project, ".omp"))) {
    if (!existsSync(join(project, "AI_Workflow_Kit", "docs", "STEPS.md"))) {
      return { ok: false, error: "в проекте есть живая память (STATE.yaml/.omp), но нет STEPS.md — восстанови STEPS.md или выбери другую папку" };
    }
    return { ok: true, seeded: false, live: true };
  }
  if (!existsSync(join(project, "AI_Workflow_Kit", "docs", "STEPS.md"))) {
    const src = kitTemplate();
    if (!existsSync(src)) return { ok: false, error: "шаблон кита не найден — укажи WF_KIT_SRC" };
    copyDir(src, join(project, "AI_Workflow_Kit"));
  }
  const rolesFile = join(project, ".cline", "workflow-roles.yaml");
  if (!existsSync(rolesFile)) {
    mkdirSync(dirname(rolesFile), { recursive: true });
    const tpl = join(HERE, "..", "assets", "roles.example.yaml");
    if (existsSync(tpl)) copyFileSync(tpl, rolesFile);
    else writeFileSync(rolesFile, "version: 1\nroles:\n");
  }
  if (!existsSync(join(project, ".git"))) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: project, timeout: 15000, env: { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" } });
      execFileSync("git", ["add", "-A"], { cwd: project, timeout: 15000, env: { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" } });
    } catch { /* панель git честно скажет «не репозиторий» */ }
  }
  return { ok: true, seeded: true, live: false };
}

function renderLanding() {
  const state = readBoardState();
  const recent = (state.recent ?? []).filter((p) => existsSync(p));
  const cards = recent.map((p) => {
    const kit = existsSync(join(p, "AI_Workflow_Kit", "docs", "STEPS.md"));
    const name = p.split("/").slice(-2).join("/");
    return `<button type="button" class="proj" data-open="${esc(p)}"><strong>${esc(name)}</strong><span class="dim">${esc(p)}</span><span class="dim">${kit ? "воркфлоу-кит есть" : "кит посеется при открытии"}</span></button>`;
  }).join("");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Пульт воркфлоу — выбери проект</title>
<style>
:root{--bg:#16130e;--panel:#201c14;--line:#3a3325;--ink:#f2ead8;--dim:#a89c80;--gold:#e0a83c;--gold-ink:#241a05}
body{font:15px/1.6 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--ink);max-width:720px;margin:0 auto;padding:48px 20px}
h1{font-size:26px;margin:0 0 6px}.dim{color:var(--dim)}
.proj{display:block;width:100%;text-align:left;font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0;cursor:pointer}
.proj:hover{border-color:var(--gold)}
.proj strong{display:block;font-size:15px}.proj span{display:block;font-size:12px}
.row{display:flex;gap:8px;margin-top:16px}
input{flex:1;font:inherit;background:#100d08;color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
button.go{background:var(--gold);color:var(--gold-ink);border:none;border-radius:10px;padding:10px 18px;font-weight:700;cursor:pointer}
.err{color:#e06c5b;margin-top:8px;min-height:20px}
</style></head><body>
<h1>Пульт воркфлоу</h1>
<div class="dim">Выбери проект — кит и роли посеются сами при первом открытии, твою память не тронем. Дальше всё внутри: шаги, роли, запуски.</div>
<div id="recent">${cards || '<p class="dim">Недавних проектов пока нет — вставь путь ниже.</p>'}</div>
<div class="row"><input id="path" placeholder="/путь/к/проекту" spellcheck="false"><button class="go" id="go" type="button">Открыть</button></div>
<div class="err" id="err"></div>
<script>
(function(){
  function openProject(p){
    var err = document.getElementById('err');
    err.textContent = 'открываю…';
    fetch('api/open', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ project: p }) })
      .then(function(r){ return r.json().then(function(b){ return { s: r.status, b: b }; }); })
      .then(function(o){
        if (o.b.ok) location.reload();
        else err.textContent = o.b.error || ('ошибка ' + o.s);
      }).catch(function(){ err.textContent = 'сервер не отвечает'; });
  }
  document.querySelectorAll('[data-open]').forEach(function(b){ b.addEventListener('click', function(){ openProject(b.getAttribute('data-open')); }); });
  document.getElementById('go').addEventListener('click', function(){ openProject(document.getElementById('path').value.trim()); });
})();
</script></body></html>`;
}
function renderBoard(project) {
  const kit = join(project, "AI_Workflow_Kit", "docs");
  const stateRaw = readIf(join(kit, "AI", "STATE.yaml"));
  const stepsRaw = readIf(join(kit, "STEPS.md"));
  const metricsRaw = readIf(join(kit, "AI", "metrics.jsonl"));
  const generatedAt = new Date().toLocaleString("ru-RU");
  if (!stateRaw && !stepsRaw) return { ok: false };
  return {
    ok: true,
    html: render({
      project,
      state: parseState(stateRaw),
      steps: parseSteps(stepsRaw),
      metrics: parseMetrics(metricsRaw),
      sessions: projectSessions(project),
      roles: rolesTable(project),
      git: gitBrief(project),
      generatedAt,
    }),
  };
}

// --- api/open: выбор проекта из лендинга (с ленивым поселением) ---
async function apiOpen(body) {
  const project = String(body?.project ?? "").trim();
  if (!project) return { ok: false, error: "укажи путь к папке проекта" };
  let resolved = project;
  try {
    resolved = resolve(project);
  } catch {
    return { ok: false, error: "некорректный путь" };
  }
  if (!existsSync(resolved)) {
    try {
      mkdirSync(resolved, { recursive: true });
    } catch {
      return { ok: false, error: "папка не существует и создать не удалось" };
    }
  }
  const ensured = ensureProject(resolved);
  if (!ensured.ok) return ensured;
  touchRecent(resolved);
  return { ok: true, project: resolved, seeded: ensured.seeded };
}

function build() {
  const project = PROJECT_ARG || activeProject();
  if (!project) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, renderLanding());
    return { ok: true, landing: true };
  }
  touchRecent(project);
  const board = renderBoard(project);
  if (!board.ok) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, renderLanding());
    return { ok: true, landing: true };
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, board.html);
  return { ok: true, project };
}

const first = build();
console.log(first.landing ? `landing → ${OUT}` : `board → ${OUT} (${first.project})`);
if (SERVE_PORT) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/providers" && req.method === "GET") {
        const data = await apiProviders(url.searchParams.get("query") ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (url.pathname === "/api/models" && req.method === "GET") {
        const data = await apiModels(url.searchParams.get("provider") ?? "", url.searchParams.get("query") ?? "");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (url.pathname === "/api/pick" && req.method === "POST") {
        const project = activeProject();
        if (!project) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "сначала выбери проект" }));
          return;
        }
        const body = await readJsonBody(req);
        const data = await apiPick(project, body);
        res.writeHead(data.ok ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (url.pathname === "/api/open" && req.method === "POST") {
        const body = await readJsonBody(req);
        const data = await apiOpen(body);
        res.writeHead(data.ok ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
        return;
      }
      if (url.pathname === "/api/state" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, project: activeProject(), ...readBoardState() }));
        return;
      }
      const project = activeProject();
      if (!project) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderLanding());
        return;
      }
      touchRecent(project);
      const board = renderBoard(project);
      if (!board.ok) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderLanding());
        return;
      }
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, board.html);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(board.html);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`board error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  server.listen(SERVE_PORT, "127.0.0.1", () => {
    console.log(`board live → http://127.0.0.1:${SERVE_PORT}/`);
  });
} else if (!ONCE && !process.argv.includes("--out") && !process.argv.includes("--project")) {
  console.log("hint: add --once for a single render, or --serve 8098 for a live page");
}
