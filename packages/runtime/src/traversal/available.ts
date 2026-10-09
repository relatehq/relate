import type { Manifest } from 'relate/model';
import {
  allowsField,
  allowsObject,
  readableObject,
  type Principal,
} from '../authorization/index.js';

type Relationship = NonNullable<Manifest['relationships']>[number];

/** One direction of a relationship, as seen from the object it starts at. */
export interface TraversalEdge {
  readonly relationship: Relationship;
  readonly forward: boolean;
}

/** Every traversal leaving an object; a self-relationship contributes both directions. */
export function traversalsFrom(
  manifest: Manifest,
  objectDefinitionId: string,
): TraversalEdge[] {
  return (manifest.relationships ?? []).flatMap((relationship) => [
    ...(relationship.fromObjectDefinitionId === objectDefinitionId
      ? [{ relationship, forward: true }]
      : []),
    ...(relationship.toObjectDefinitionId === objectDefinitionId
      ? [{ relationship, forward: false }]
      : []),
  ]);
}

const linkOwnerId = (relationship: Relationship) =>
  'through' in relationship
    ? relationship.through.objectDefinitionId
    : relationship.toObjectDefinitionId;

/** Reference traversal scans its owner's source; a native-only owner has none. */
export function traversalSupported(
  manifest: Manifest,
  relationship: Relationship,
): boolean {
  return (
    'through' in relationship ||
    Boolean(
      manifest.objects.find((o) => o.id === linkOwnerId(relationship))
        ?.sourceDefinitionId,
    )
  );
}

/**
 * The role-level gate on a traversal: the actor may read the link owner, every
 * link reference field, and the destination type. Record-level policy still
 * applies to each read, so passing this gate never reveals a record by itself.
 */
export function traversalAllowed(
  manifest: Manifest,
  principal: Principal,
  { relationship, forward }: TraversalEdge,
): boolean {
  const policyFor = (id: string) =>
    Object.hasOwn(manifest.policies, id) ? manifest.policies[id] : undefined;
  const owner = manifest.objects.find(
    (o) => o.id === linkOwnerId(relationship),
  );
  const ownerPolicy = owner && policyFor(owner.id);
  const targetId = forward
    ? relationship.toObjectDefinitionId
    : relationship.fromObjectDefinitionId;
  const links =
    'through' in relationship
      ? [
          relationship.through.fromReferencePropertyDefinitionId,
          relationship.through.toReferencePropertyDefinitionId,
        ]
      : [relationship.referencePropertyDefinitionId];

  return Boolean(
    owner &&
    ownerPolicy &&
    allowsObject(principal, ownerPolicy) &&
    allowsObject(principal, policyFor(targetId)) &&
    links.every((id) => {
      const property = owner.properties.find((p) => p.id === id);

      return Boolean(
        property && allowsField(principal, ownerPolicy, property.access),
      );
    }),
  );
}

/**
 * The traversals an actor may attempt from an object: from a readable type,
 * executable, gated by `traversalAllowed`, and leading to a readable type. Discovery lists exactly
 * these, and request errors offer only these names.
 */
export function availableTraversals(
  manifest: Manifest,
  principal: Principal,
  objectDefinitionId: string,
) {
  // An unreadable start type has no discoverable traversals at all.
  if (!readableObject(manifest, principal, objectDefinitionId)) return [];

  return traversalsFrom(manifest, objectDefinitionId).flatMap((edge) => {
    const { relationship, forward } = edge;
    const target = readableObject(
      manifest,
      principal,
      forward
        ? relationship.toObjectDefinitionId
        : relationship.fromObjectDefinitionId,
    );

    return target &&
      traversalSupported(manifest, relationship) &&
      traversalAllowed(manifest, principal, edge)
      ? [
          {
            ...edge,
            traversal: forward ? relationship.forward : relationship.reverse,
            target,
          },
        ]
      : [];
  });
}
