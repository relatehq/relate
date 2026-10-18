/** Paths are relative to packages/runtime/src. Unknown owners fail closed. */
const dependencies: Record<string, readonly string[]> = {
  public: [
    'activity',
    'composition',
    'actions',
    'authorization',
    'discovery',
    'observations',
    'memory',
  ],
  composition: [
    'activity',
    'actions',
    'authorization',
    'resolution',
    'traversal',
    'queries',
    'reads',
    'storage',
    'memory',
    'discovery',
  ],
  actions: ['activity', 'authorization', 'reads', 'storage'],
  resolution: ['activity', 'authorization', 'observations', 'reads', 'storage'],
  traversal: ['authorization', 'reads', 'storage'],
  queries: ['authorization', 'reads', 'storage'],
  authorization: ['storage'],
  // Discovery reuses the enforcement gates rather than restating them, and
  // describes read options from the same table request validation uses.
  discovery: ['authorization', 'actions', 'traversal', 'reads'],
  observations: ['storage'],
  reads: [],
  storage: ['observations', 'activity'],
  activity: ['observations'],
  memory: ['storage', 'observations', 'activity'],
};
const roots: Record<string, string> = {
  'index.ts': 'public',
  'runtime.ts': 'composition',
  'storage.ts': 'storage',
  'memory.ts': 'memory',
  'native-memory.ts': 'memory',
  'discovery.ts': 'discovery',
  'contracts.ts': 'discovery',
};
const folders = new Set([
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
    ['observations/ordering.ts', 'observations/changes.ts'].includes(to);
  const contract =
    target === 'storage' &&
    ((owner !== 'observations' && owner !== 'authorization') || typeOnly);
  const entry =
    target === 'storage'
      ? contract
      : owner === 'activity' && target === 'observations'
        ? to === 'observations/changes.ts'
        : target === 'observations' &&
            (owner === 'storage' || owner === 'memory')
          ? ordering
          : folders.has(target)
            ? to === `${target}/index.ts`
            : true;

  if (!allowed || !entry)
    throw new Error(
      `Forbidden runtime dependency: ${from} -> ${to}${typeOnly ? ' (type)' : ''}`,
    );
}
