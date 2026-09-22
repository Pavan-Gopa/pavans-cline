# Переезд в форк — статус

## Уже в `~/Forks/cline/.pavan/` (портировано 1:1, проверяется)

| Модуль | Откуда | Статус |
|---|---|---|
| `workflow-plugin/*.ts` | `CLINE WORKFLOW/cline-pavans-workflow/` | Портировано полностью (8 файлов: index, roles, roles-config, rules, tools, guards, command, picker) |
| `workflow-plugin/scripts/*.py` | `CLINE WORKFLOW/scripts/` | Гейты + security-scope, без изменений |
| `workflow-plugin/assets/roles.example.yaml` | `CLINE WORKFLOW/assets/` | Без изменений |
| `board/dashboard.mjs` | `CLINE WORKFLOW/dashboard/` | Портирован (лендинг + пульт + API pick) |
| `proxies/xai-oauth/loopback-proxy.mjs` | `CLINE WORKFLOW/providers/` | Без изменений (рабочий TODAY-путь) |
| `proxies/xai-oauth/xai-oauth.ts` | **Новое** | Нативный протоколный модуль (роутинг, skew, backoff, валидация) |
| `proxies/antigravity/antigravity.ts` | **Новое** | Курированный каталог + константы (чат ждёт fresh login) |
| `overlay/HOOKS.md` | **Новое** | Точки врезки Alt+W/panel (5 строк каждая) |
| `overlay/workflow-board-pane.tsx` | **Новое** | Заглушка панели под React-порт |

## Тонкие хуки в апстрим (следующий шаг, по одному)

1. `sdk/.../builtin-types.ts`: `ProviderFamily += "xai-oauth" | "antigravity"`.
2. `sdk/.../builtins.ts`: два `BuiltinSpec` (семья, capabilities oauth, modelsFactory, defaults baseUrl).
3. `sdk/.../builtins-runtime.ts`: два `case` → фабрики из `.pavan/proxies/*/`.
4. `sdk/.../vendors/community.ts` (или новый `vendors/pavan.ts`): `createXaiOauthProviderModule`, `createAntigravityProviderModule`.
5. `webview/lib/desktop-app-state.ts`: `DesktopAppView += "workflow"`.
6. `webview/components/agent-sidebar.tsx`: `AppView += "workflow"` + строка навигации.
7. `webview/app/page.tsx`: case панели + Alt+W в keydown-хук (Alt+M остаётся нативным — провайдеры).

Каждый хук помечен `// [+pavan]`. Конфликт при `merge upstream/main` = эти строки, не наши модули.
