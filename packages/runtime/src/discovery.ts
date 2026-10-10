import type {
  ActionDescription,
  ActionFieldDescription,
  Discovery,
  GraphDescription,
  ObjectDescription,
  ObjectSummary,
} from '@relate/protocol';
import type { Manifest } from 'relate/model';
import { deepFreeze } from 'relate/model';
import {
  readableObject,
  readableProperties,
  type Principal,
} from './authorization/index.js';
import { actionAllowed } from './actions/index.js';
import { availableTraversals } from './traversal/index.js';
import { operationContracts } from './contracts.js';
import { schemaText, filterOperators } from './reads/index.js';

type ManifestObject = Manifest['objects'][number];

type ManifestAction = NonNullable<Manifest['actions']>[number];

type ActionField = ManifestAction['input'][string];

/** Omits absent descriptions so results keep exact optional properties. */
function described(description: string | undefined) {
  return description !== undefined ? { description } : {};
}

function summary(object: ManifestObject): ObjectSummary {
  return {
    definitionId: object.id,
    apiName: object.apiName,
    label: object.label,
    pluralLabel: object.pluralLabel,
    ...described(object.description),
  };
}

/** Caches one frozen value per key; discovery is a pure function of an actor snapshot. */
function memoize<T>(build: (key: string) => T) {
  const cache = new Map<string, T>();

  return (key: string): T => {
    if (!cache.has(key)) cache.set(key, build(key));

    return cache.get(key)!;
  };
}

/**
 * Build a metadata-only view of the capabilities statically available to one
 * actor. It applies the same role-level gates as enforcement (`allowsObject`,
 * `traversalAllowed`, `actionAllowed`), so a listed capability is one the
 * runtime will attempt; record-level policy still decides each result.
 */
export function createDiscovery(
  manifest: Manifest,
  principal: Principal,
): Discovery {
  const readable = (id: string | undefined) =>
    readableObject(manifest, principal, id);
  const actionFields = (fields: Readonly<Record<string, ActionField>>) =>
    Object.entries(fields).map(([name, field]) => {
      const { description, references, ...schema } = field;
      const target = readable(references);

      return {
        name,
        ...described(description),
        schema,
        ...(target ? { references: summary(target) } : {}),
      } satisfies ActionFieldDescription;
    });
  const visibleActions = () =>
    (manifest.actions ?? []).filter((action) =>
      actionAllowed(manifest, principal, action),
    );

  const describeObject = memoize(
    (definitionId: string): ObjectDescription | undefined => {
      const object = readable(definitionId);

      if (!object) return undefined;

      const properties = readableProperties(manifest, principal, object).map(
        ({ property, target }) => ({
          definitionId: property.id,
          name: property.name,
          ...described(property.description),
          kind:
            property.origin.kind === 'object-id'
              ? ('object-id' as const)
              : target
                ? ('reference' as const)
                : ('value' as const),
          schema: property.schema,
          ...(target ? { references: summary(target) } : {}),
          filterOperators: filterOperators(property.schema),
          filter: schemaText(
            property.schema,
            property.origin.kind === 'object-id'
              ? object.apiName
              : target?.apiName,
          ),
        }),
      );
      const traversals = availableTraversals(
        manifest,
        principal,
        object.id,
      ).map(({ relationship, traversal, target }) => ({
        relationshipDefinitionId: relationship.id,
        name: traversal.name,
        ...described(traversal.description),
        cardinality: traversal.cardinality,
        target: summary(target),
        returns:
          traversal.cardinality === 'many'
            ? `QueryResult<${target.apiName}>`
            : `Promise<ObjectResult<${target.apiName}>>`,
      }));

      return deepFreeze({
        ...summary(object),
        operations: {
          get: { returns: `Promise<ObjectResult<${object.apiName}>>` },
          query: {
            returns: `QueryResult<${object.apiName}>`,
            collectionScope: 'graph-membership' as const,
          },
        },
        properties,
        traversals,
      });
    },
  );

  const describeAction = memoize(
    (definitionId: string): ActionDescription | undefined => {
      const action = visibleActions().find(
        (candidate) => candidate.id === definitionId,
      );

      if (!action) return undefined;

      return deepFreeze({
        definitionId: action.id,
        apiName: action.apiName,
        ...described(action.description),
        input: actionFields(action.input),
        output: actionFields(action.output),
        errors: Object.fromEntries(
          Object.entries(action.errors ?? {}).map(([code, fields]) => [
            code,
            actionFields(fields),
          ]),
        ),
        creates: action.creates.flatMap((id) => {
          const object = readable(id);

          return object ? [summary(object)] : [];
        }),
      });
    },
  );

  let graph: GraphDescription | undefined;
  const describe = () =>
    (graph ??= deepFreeze({
      definitionId: manifest.graphDefinitionId,
      ...described(manifest.description),
      objects: manifest.objects.filter((o) => readable(o.id)).map(summary),
      actions: visibleActions().map((action) => ({
        definitionId: action.id,
        apiName: action.apiName,
        ...described(action.description),
      })),
      operations: operationContracts,
    }));

  return Object.freeze({
    describe: (): GraphDescription => describe(),
    describeObject: (definitionId: string) => describeObject(definitionId),
    describeAction: (definitionId: string) => describeAction(definitionId),
  });
}
