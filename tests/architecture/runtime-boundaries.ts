/** Paths are relative to packages/runtime/src. Unknown owners fail closed. */
const dependencies: Record<string, readonly string[]> = {
  public: [
    'composition',
    'actions',
    'authorization',
    'discovery',
    'observations',
    'memory',
    'activity',
    'analytics',
  ],
  composition: [
    'analytical-reads',
    'analytics',
    'actions',
    'authorization',
    'resolution',
    'traversal',
    'queries',
    'reads',
    'storage',
    'memory',
    'discovery',
    'activity',
  ],
  'analytical-reads': [
    'authorization',
    'queries',
    'reads',
    'analytics',
    'activity',
  ],
  actions: ['authorization', 'reads', 'storage', 'activity'],
  resolution: [
    'authorization',
    'observations',
    'reads',
    'storage',
    'activity',
    'actions',
  ],
  traversal: ['authorization', 'reads', 'storage', 'activity'],
  queries: ['authorization', 'reads', 'storage', 'activity', 'actions'],
  authorization: ['storage'],
  // Discovery reuses the enforcement gates rather than restating them, and
  // describes read options from the same table request validation uses.
  discovery: ['authorization', 'actions', 'traversal', 'reads', 'analytics'],
  observations: ['storage'],
  reads: [],
  storage: ['observations'],
  memory: ['storage', 'observations'],
  // Operation capture: scopes, lineage and the best-effort queue.
  activity: ['storage'],
  // Analytical execution owns its admission queue; dependencies arrive as input.
  analytics: [],
};
const roots: Record<string, string> = {
  'index.ts': 'public',
  'runtime.ts': 'composition',
  'analytics-startup.ts': 'composition',
  'storage.ts': 'storage',
  'activity-store.ts': 'storage',
  'memory.ts': 'memory',
  'native-memory.ts': 'memory',
  'memory-activity.ts': 'memory',
  'memory-order.ts': 'memory',
};
const folders = new Set([
  'analytical-reads',
  'discovery',
  'analytics',
  'activity',
  'actions',
  'authorization',
  'resolution',
  'traversal',
  'queries',
  'observations',
  'reads',
]);

export function runtimeOwner(file: string): string {
  const folder = file.replaceAll('\\', '/').split('/')[0]!;
  const owner = roots[file] ?? (folders.has(folder) ? folder : undefined);

  if (!owner) throw new Error(`Unowned runtime module: ${file}`);

  return owner;
}

export function assertRuntimeDependency(
  from: string,
  to: string,
  typeOnly: boolean,
): void {
  from = from.replaceAll('\\', '/');
  to = to.replaceAll('\\', '/');
  const owner = runtimeOwner(from),
    target = runtimeOwner(to);

  if (owner === target) return;

  const allowed = dependencies[owner]!.includes(target);
  // Storage contracts are independent of fetching; only the public pure ordering
  // operation is re-exported for adapters. The reverse edge carries types only.
  const ordering =
    (owner === 'storage' || owner === 'memory') &&
    (to === 'observations/ordering.ts' || to === 'observations/changes.ts');
  const contract =
    target === 'storage' &&
    ((owner !== 'observations' && owner !== 'authorization') || typeOnly);
  const entry =
    target === 'storage'
      ? contract
      : target === 'observations' && (owner === 'storage' || owner === 'memory')
        ? ordering
        : folders.has(target)
          ? to === `${target}/index.ts`
          : true;

  const scopeOnly =
    target === 'activity' && (owner === 'queries' || owner === 'traversal');

  if (!allowed || !entry || (scopeOnly && !typeOnly))
    throw new Error(
      `Forbidden runtime dependency: ${from} -> ${to}${typeOnly ? ' (type)' : ''}`,
    );
}
