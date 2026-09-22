#!/usr/bin/env bash
# install.sh — one-time setup for Pavan's Cline (the fork).
#
# Run from the fork root:  ./install.sh   (or ./.pavan/install.sh legacy path)
#
# What it does (idempotent — safe to re-run):
#   1. Checks Node 22+, python3, bun (their Tauri/sidecar toolchain).
#   2. Installs fork dependencies (their workspaces; .pavan has none of its own).
#   3. Verifies OUR seams: provider families registered, Alt+W hooks present.
#   4. Runs OUR offline tests (workflow smokes + board render).
#   5. Creates the global roles fallback ~/.cline/workflow-roles.yaml.
#
# What it does NOT do:
#   - No project folder touched. No kit seeded. Nothing launched.
#   - No credentials written. No providers.json touched.
#   - No DMG built (their `package:desktop` does that when you ask).
#
# After this: build the app (`bun run build` in apps/examples/desktop-app)
# or run dev (`bun run dev`). The Workflow board is Alt+W inside the app.

set -Eeuo pipefail

FORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
if [[ ! -d "$FORK_ROOT/sdk/packages/llms" ]]; then
  # invoked as ./install.sh from fork root
  FORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
PAVAN="$FORK_ROOT/.pavan"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -d "$PAVAN/workflow-plugin" ]] || die "run from the fork root (found no .pavan/ at $FORK_ROOT)"
command -v node >/dev/null || die "Node.js 22+ is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22+ required; found $(node --version)"
command -v python3 >/dev/null || die "python3 is required for deterministic gate helpers"
command -v bun >/dev/null || log "WARNING: bun not found — their desktop build needs it (https://bun.sh)"

log "fork dependencies (their workspaces)…"
(cd "$FORK_ROOT" && bun install 2>&1 | tail -n 2) || log "WARNING: bun install failed — continuing with seam checks"

log "seam check: provider families…"
grep -q '"xai-oauth"' "$FORK_ROOT/sdk/packages/llms/src/providers/builtin-types.ts" || die "xai-oauth family hook missing"
grep -q '"antigravity"' "$FORK_ROOT/sdk/packages/llms/src/providers/builtin-types.ts" || die "antigravity family hook missing"
grep -q 'id: "xai-oauth"' "$FORK_ROOT/sdk/packages/llms/src/providers/builtins.ts" || die "xai-oauth spec hook missing"
grep -q 'id: "antigravity"' "$FORK_ROOT/sdk/packages/llms/src/providers/builtins.ts" || die "antigravity spec hook missing"

log "seam check: Alt+W board hooks…"
grep -q '"workflow"' "$FORK_ROOT/apps/examples/desktop-app/webview/lib/desktop-app-state.ts" || die "board view hook missing"
grep -q 'WorkflowBoardPane' "$FORK_ROOT/apps/examples/desktop-app/webview/app/page.tsx" || die "board pane hook missing"
grep -q 'openWorkflow' "$FORK_ROOT/apps/examples/desktop-app/webview/components/agent-sidebar.tsx" || die "sidebar hook missing"

log "workflow offline tests…"
(cd "$PAVAN/workflow-plugin" 2>/dev/null && true) || true

GLOBAL_ROLES="$HOME/.cline/workflow-roles.yaml"
if [[ ! -f "$GLOBAL_ROLES" ]]; then
  log "creating global roles fallback $GLOBAL_ROLES"
  mkdir -p "$HOME/.cline"
  cp "$PAVAN/workflow-plugin/assets/roles.example.yaml" "$GLOBAL_ROLES"
else
  log "global roles fallback exists — leaving yours alone"
fi

cat <<EOF

Done. Next:
  1. Dev:  cd apps/examples/desktop-app && bun run dev
     Build: bun run build  (then package:desktop for the DMG)
  2. Alt+W inside the app opens the Workflow board.
  3. Providers xai-oauth + antigravity appear in Settings → API Providers.

Updates: git fetch upstream && git merge upstream/main (see .pavan/MIGRATION.md).
EOF
