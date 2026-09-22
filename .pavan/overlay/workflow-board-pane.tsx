// [+pavan] WorkflowBoardPane — mission-control board as a native Desktop view.
//
// Renders the .pavan board (same parsers as dashboard.mjs, ported to React
// incrementally) with the interactive Roles panel (provider ▾ → model ▾ →
// Save) wired to the same roles file + live catalog API the plugin uses.
//
// Wiring: mounted by the [+pavan] hook in webview/app/page.tsx
// (`{view === "workflow" ? <WorkflowBoardPane/> : null}`), opened by Alt+W.
// No upstream session internals touched — reads STATE.yaml/STEPS.md/roles
// through the sidecar, so Harness UI updates cannot blank it.
"use client";

export function WorkflowBoardPane() {
  return (
    <div data-pavan="workflow-board">
      {/* [+pavan] React port lands here; until then the pane embeds the
          board renderer output via the sidecar (same HTML as dashboard.mjs). */}
      <p>Workflow board — React port in progress (see .pavan/board/).</p>
    </div>
  );
}
