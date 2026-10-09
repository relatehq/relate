import type { Manifest, ScalarSchema } from 'relate/model';
import { deepFreeze } from 'relate/model';
import { allowsField, type Principal } from './authorization/index.js';

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

function summary(object: ManifestObject): ObjectSummary {
  return {
    definitionId: object.id,
    apiName: object.apiName,
    label: object.label,
    pluralLabel: object.pluralLabel,
    ...(object.description !== undefined
      ? { description: object.description }
      : {}),
  };
}

/** Build a metadata-only view of the capabilities statically available to one actor. */
export function createDiscovery(manifest: Manifest, principal: Principal) {
  const objectById = new Map(
    manifest.objects.map((object) => [object.id, object]),
  );
  const canRead = (object: ManifestObject | undefined) => {
    if (!object) return false;

    const policy = manifest.policies[object.id];

    return Boolean(policy && principal.roles.includes(policy.read.role));
  };
  const visibleObjects = manifest.objects.filter(canRead);
  const visibleActions = (manifest.actions ?? []).filter(
    (action) =>
      Boolean(
        action.execute &&
        principal.id.trim() &&
        principal.roles.includes(action.execute.role),
      ) &&
      Object.values(action.input).every(
        (field) =>
          !field.references || canRead(objectById.get(field.references)),
      ),
  );
  const actionFields = (fields: Readonly<Record<string, ActionField>>) =>
    Object.entries(fields).map(([name, field]) => {
      const { description, references, ...schema } = field;
      const target = references ? objectById.get(references) : undefined;

      return {
        name,
        ...(description !== undefined ? { description } : {}),
        schema,
        ...(target && canRead(target) ? { references: summary(target) } : {}),
      } satisfies ActionFieldDescription;
    });

  const describeObject = (
    definitionId: string,
  ): ObjectDescription | undefined => {
    const object = objectById.get(definitionId);

    if (!object || !canRead(object)) return undefined;

    const policy = manifest.policies[object.id]!;
    const properties = object.properties.flatMap((property) => {
      if (!allowsField(principal, policy, property.access)) return [];

      const referenceId =
        property.origin.kind === 'reference' ||
        property.origin.kind === 'native-reference'
          ? property.origin.targetObjectDefinitionId
          : undefined;
      const target = referenceId ? objectById.get(referenceId) : undefined;

      if (referenceId && !canRead(target)) return [];

      return [
        {
          definitionId: property.id,
          name: property.name,
          ...(property.description !== undefined
            ? { description: property.description }
            : {}),
          kind:
            property.origin.kind === 'object-id'
              ? ('object-id' as const)
              : referenceId
                ? ('reference' as const)
                : ('value' as const),
          schema: property.schema,
          ...(target ? { references: summary(target) } : {}),
        },
      ];
    });
    const traversals = (manifest.relationships ?? []).flatMap(
      (relationship) => {
        let direction:
          | {
              traversal: {
                readonly name: string;
                readonly cardinality: 'one' | 'many';
                readonly description?: string | undefined;
              };
              targetId: string;
            }
          | undefined;

        if (relationship.fromObjectDefinitionId === object.id)
          direction = {
            traversal: relationship.forward,
            targetId: relationship.toObjectDefinitionId,
          };
        else if (relationship.toObjectDefinitionId === object.id)
          direction = {
            traversal: relationship.reverse,
            targetId: relationship.fromObjectDefinitionId,
          };

        if (!direction) return [];

        const target = objectById.get(direction.targetId);
        const anchorId =
          'through' in relationship
            ? relationship.through.objectDefinitionId
            : relationship.toObjectDefinitionId;
        const anchor = objectById.get(anchorId);
        const anchorPolicy = anchor && manifest.policies[anchor.id];
        const referenceIds =
          'through' in relationship
            ? [
                relationship.through.fromReferencePropertyDefinitionId,
                relationship.through.toReferencePropertyDefinitionId,
              ]
            : [relationship.referencePropertyDefinitionId];
        const referencesVisible =
          anchor &&
          anchorPolicy &&
          principal.roles.includes(anchorPolicy.read.role) &&
          referenceIds.every((id) => {
            const property = anchor.properties.find(
              (candidate) => candidate.id === id,
            );

            return Boolean(
              property && allowsField(principal, anchorPolicy, property.access),
            );
          });

        if (!target || !canRead(target) || !referencesVisible) return [];

        return [
          {
            relationshipDefinitionId: relationship.id,
            name: direction.traversal.name,
            ...(direction.traversal.description !== undefined
              ? { description: direction.traversal.description }
              : {}),
            cardinality: direction.traversal.cardinality,
            target: summary(target),
          },
        ];
      },
    );

    return deepFreeze({
      ...summary(object),
      operations: {
        get: true as const,
        query: { collectionScope: 'graph-membership' as const },
      },
      properties,
      traversals,
    });
  };

  const describeAction = (
    definitionId: string,
  ): ActionDescription | undefined => {
    const action = visibleActions.find(
      (candidate) => candidate.id === definitionId,
    );

    if (!action) return undefined;

    return deepFreeze({
      definitionId: action.id,
      apiName: action.apiName,
      ...(action.description !== undefined
        ? { description: action.description }
        : {}),
      input: actionFields(action.input),
      output: actionFields(action.output),
      errors: Object.fromEntries(
        Object.entries(action.errors ?? {}).map(([code, fields]) => [
          code,
          actionFields(fields),
        ]),
      ),
      creates: action.creates.flatMap((id) => {
        const object = objectById.get(id);

        return object && canRead(object) ? [summary(object)] : [];
      }),
    });
  };

  return Object.freeze({
    describe(): GraphDescription {
      return deepFreeze({
        definitionId: manifest.graphDefinitionId,
        ...(manifest.description !== undefined
          ? { description: manifest.description }
          : {}),
        objects: visibleObjects.map(summary),
        actions: visibleActions.map((action) => ({
          definitionId: action.id,
          apiName: action.apiName,
          ...(action.description !== undefined
            ? { description: action.description }
            : {}),
        })),
      });
    },
    describeObject,
    describeAction,
  });
}
