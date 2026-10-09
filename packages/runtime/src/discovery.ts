import type { Manifest, ScalarSchema } from 'relate/model';
import { deepFreeze } from 'relate/model';
import {
  allowsField,
  allowsObject,
  type Principal,
} from './authorization/index.js';
import { actionAllowed } from './actions/index.js';
import {
  traversalAllowed,
  traversalsFrom,
  traversalSupported,
} from './traversal/index.js';

type ManifestObject = Manifest['objects'][number];

type ManifestAction = NonNullable<Manifest['actions']>[number];

type ActionField = ManifestAction['input'][string];

export interface ObjectSummary {
  readonly definitionId: string;
  readonly apiName: string;
  readonly label: string;
  readonly pluralLabel: string;
  readonly description?: string;
}

export interface ActionSummary {
  readonly definitionId: string;
  readonly apiName: string;
  readonly description?: string;
}

export interface GraphDescription {
  readonly definitionId: string;
  readonly description?: string;
  readonly objects: readonly ObjectSummary[];
  readonly actions: readonly ActionSummary[];
}

export interface PropertyDescription {
  readonly definitionId: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: 'object-id' | 'value' | 'reference';
  readonly schema: ScalarSchema;
  readonly references?: ObjectSummary;
}

export interface TraversalDescription {
  readonly relationshipDefinitionId: string;
  readonly name: string;
  readonly description?: string;
  readonly cardinality: 'one' | 'many';
  readonly target: ObjectSummary;
}

export interface ObjectDescription extends ObjectSummary {
  readonly operations: {
    readonly get: true;
    readonly query: { readonly collectionScope: 'graph-membership' };
  };
  readonly properties: readonly PropertyDescription[];
  readonly traversals: readonly TraversalDescription[];
}

export interface ActionFieldDescription {
  readonly name: string;
  readonly description?: string;
  readonly schema: ScalarSchema;
  readonly references?: ObjectSummary;
}

export interface ActionDescription extends ActionSummary {
  readonly input: readonly ActionFieldDescription[];
  readonly output: readonly ActionFieldDescription[];
  readonly errors: Readonly<Record<string, readonly ActionFieldDescription[]>>;
  readonly creates: readonly ObjectSummary[];
}

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
export function createDiscovery(manifest: Manifest, principal: Principal) {
  const objectById = new Map(
    manifest.objects.map((object) => [object.id, object]),
  );
  const policyFor = (id: string) =>
    Object.hasOwn(manifest.policies, id) ? manifest.policies[id] : undefined;
  const readable = (id: string | undefined) => {
    const object = id === undefined ? undefined : objectById.get(id);

    return object && allowsObject(principal, policyFor(object.id))
      ? object
      : undefined;
  };
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

      const policy = policyFor(object.id)!;
      const properties = object.properties.flatMap((property) => {
        if (!allowsField(principal, policy, property.access)) return [];

        const referenceId =
          property.origin.kind === 'reference' ||
          property.origin.kind === 'native-reference'
            ? property.origin.targetObjectDefinitionId
            : undefined;
        const target = readable(referenceId);

        if (referenceId && !target) return [];

        return [
          {
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
          },
        ];
      });
      const traversals = traversalsFrom(manifest, object.id).flatMap((edge) => {
        const { relationship, forward } = edge;
        const traversal = forward ? relationship.forward : relationship.reverse;
        const target = readable(
          forward
            ? relationship.toObjectDefinitionId
            : relationship.fromObjectDefinitionId,
        );

        if (
          !target ||
          !traversalSupported(manifest, relationship) ||
          !traversalAllowed(manifest, principal, edge)
        )
          return [];

        return [
          {
            relationshipDefinitionId: relationship.id,
            name: traversal.name,
            ...described(traversal.description),
            cardinality: traversal.cardinality,
            target: summary(target),
          },
        ];
      });

      return deepFreeze({
        ...summary(object),
        operations: {
          get: true as const,
          query: { collectionScope: 'graph-membership' as const },
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
    }));

  return Object.freeze({
    describe: (): GraphDescription => describe(),
    describeObject: (definitionId: string) => describeObject(definitionId),
    describeAction: (definitionId: string) => describeAction(definitionId),
  });
}
