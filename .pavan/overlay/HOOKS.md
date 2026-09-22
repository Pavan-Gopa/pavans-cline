// [+pavan] Workflow board overlay — thin hook, fat .pavan module.
//
// This is the ONLY kind of change we make to upstream webview files:
// a 5-line hook that mounts our panel. All board logic lives in
// .pavan/overlay/workflow-board.tsx (untouched by upstream merges
// unless they rewrite this exact switch — then the conflict is HERE,
// in 5 lines, not in 500).
//
// Wiring (manual, one time):
//   1. DesktopAppView += "workflow" in lib/desktop-app-state.ts  [+pavan]
//   2. agent-sidebar.tsx: AppView += "workflow" + one nav row      [+pavan]
//   3. page.tsx view switch += case below                          [+pavan]
//   4. page.tsx keydown handler += Alt+W (Alt+M → settings "API Providers")
//
// ```tsx
// // [+pavan] in page.tsx, next to {view === "sessions" ? ...}:
// {view === "workflow" ? (
//   <WorkflowBoardPane key={`workflow:${activeEnvironmentId}`} />
// ) : null}
// ```
//
// ```tsx
// // [+pavan] in the Cmd/Ctrl+ keydown handler, same useEffect:
// } else if (event.key === "w" || event.key === "W") {
//   event.preventDefault();
//   handleViewChange("workflow");          // Alt+W — mission-control board
// }
// // Alt+M keeps native meaning: providers tab (role routes read it).
// ```
//
// The pane itself renders .pavan board HTML (dashboard.mjs output) or,
// once ported, the React board. It talks to the sidecar for
// STATE.yaml/STEPS.md/roles — never to upstream session internals,
// so Harness UI updates cannot blank it (same principle as DSH overlay.js).

export {};
