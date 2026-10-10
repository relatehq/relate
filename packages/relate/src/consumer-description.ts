/** Plain routing data. The public ConsumerDescription maps these fields to graph types. */
export interface ConsumerRoutingDescription {
  readonly formatVersion: 1;
  readonly graphDefinitionId: string;
  readonly definitionRevision: string;
  readonly objects: Readonly<
    Record<
      string,
      {
        readonly definitionId: string;
        readonly traversals: Readonly<
          Record<
            string,
            {
              readonly cardinality: 'one' | 'many';
              readonly target: string;
            }
          >
        >;
      }
    >
  >;
  readonly actions: Readonly<Record<string, { readonly definitionId: string }>>;
}

/** Validate JSON shape and copy routing; never retain or freeze caller-owned objects. */
export function captureConsumerDescription(
  value: unknown,
): ConsumerRoutingDescription {
  const fail = (path: string): never => {
    throw new Error(`Invalid consumer description: ${path}`);
  };
  const record = (value: unknown, path: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail(path);

    return value as Record<string, unknown>;
  };
  const text = (value: unknown, path: string): string => {
    if (typeof value !== 'string' || !value.trim()) return fail(path);

    return value;
  };
  const names = (value: unknown, path: string) =>
    Object.entries(record(value, path)).map(([name, item]) => {
      if (
        !name.trim() ||
        ['__proto__', 'constructor', 'prototype'].includes(name)
      )
        fail(`${path}.${name}`);

      return [name, record(item, `${path}.${name}`)] as const;
    });
  const root = record(value, 'root');

  if (root.formatVersion !== 1) fail('formatVersion');

  const graphDefinitionId = text(root.graphDefinitionId, 'graphDefinitionId');
  const definitionRevision = text(
    root.definitionRevision,
    'definitionRevision',
  );

  if (!/^sha256:[a-f0-9]{64}$/.test(definitionRevision))
    fail('definitionRevision');

  const ids = new Set<string>();
  const objects = Object.fromEntries(
    names(root.objects, 'objects').map(([name, object]) => {
      const path = `objects.${name}`;
      const definitionId = text(object.definitionId, `${path}.definitionId`);

      if (ids.has(definitionId)) fail(`${path}.definitionId`);

      ids.add(definitionId);
      const traversals = Object.fromEntries(
        names(object.traversals, `${path}.traversals`).map(([name, edge]) => {
          const cardinality = edge.cardinality;

          if (cardinality !== 'one' && cardinality !== 'many')
            return fail(`${path}.traversals.${name}.cardinality`);

          return [
            name,
            Object.freeze({
              cardinality,
              target: text(edge.target, `${path}.traversals.${name}.target`),
            }),
          ];
        }),
      );

      return [
        name,
        Object.freeze({ definitionId, traversals: Object.freeze(traversals) }),
      ];
    }),
  );

  for (const object of Object.values(objects))
    for (const edge of Object.values(object.traversals))
      if (!Object.hasOwn(objects, edge.target))
        fail(`Unknown traversal target '${edge.target}'`);

  const actions = Object.fromEntries(
    names(root.actions, 'actions').map(([name, action]) => {
      const definitionId = text(
        action.definitionId,
        `actions.${name}.definitionId`,
      );

      if (ids.has(definitionId)) fail(`actions.${name}.definitionId`);

      ids.add(definitionId);

      return [name, Object.freeze({ definitionId })];
    }),
  );

  return Object.freeze({
    formatVersion: 1,
    graphDefinitionId,
    definitionRevision,
    objects: Object.freeze(objects),
    actions: Object.freeze(actions),
  });
}
