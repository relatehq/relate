/** Paths are relative to packages/runtime/src. Unknown owners fail closed. */
const dependencies: Record<string, readonly string[]> = {
  public: [
    'composition',
    'actions',
    'authorization',
    'observations',
    'memory',
    'pagination',
  ],
  composition: [
    'actions',
    'authorization',
    'resolution',
    'traversal',
    'queries',
    'storage',
    'memory',
  ],
  actions: ['authorization', 'reads', 'storage'],
  resolution: ['authorization', 'observations', 'reads', 'storage'],
  traversal: ['authorization', 'reads', 'storage'],
  queries: ['authorization', 'reads', 'storage'],
  authorization: ['storage'],
  observations: ['storage'],
  reads: [],
  storage: ['observations'],
  memory: ['storage', 'observations'],
  pagination: [],
};
const roots: Record<string, string> = {
  'index.ts': 'public',
  'runtime.ts': 'composition',
  'storage.ts': 'storage',
  'memory.ts': 'memory',
  'native-memory.ts': 'memory',
  'pagination.ts': 'pagination',
};
const folders = new Set([
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
    to === 'observations/ordering.ts';
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

  if (!allowed || !entry)
    throw new Error(
      `Forbidden runtime dependency: ${from} -> ${to}${typeOnly ? ' (type)' : ''}`,
    );
}
