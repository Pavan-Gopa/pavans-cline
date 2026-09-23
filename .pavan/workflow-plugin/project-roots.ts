// project-roots.ts — session→workspace root map, dependency-free on purpose.
//
// tools.ts (agent-plugin lane, loaded via jiti) and roles-config.ts (also
// imported straight by the Desktop sidecar under bun) share this module, so
// it must stay free of bare package imports: node builtins only, no imports
// at all. Import it extensionless (`./project-roots`) — bun resolves it,
// and the plugin loader maps it like the other relative modules.

const rootsBySession = new Map<string, string>();

export function setWorkspaceRoot(sessionId: string | undefined, root: string | undefined): void {
  if (sessionId && root) rootsBySession.set(sessionId, root);
}

export function knownWorkspaceRoots(): IterableIterator<string> {
  return rootsBySession.values();
}

/** Session root from setup(), else the host cwd. Never throws. */
export function resolveProjectRoot(override?: string): string {
  if (override) return override;
  const first = rootsBySession.values().next();
  return !first.done && first.value ? first.value : process.cwd();
}
