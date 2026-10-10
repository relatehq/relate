import type { Manifest } from 'relate/model';
import { allowsField, allowsObject, type Principal } from './policy.js';

type ManifestObject = Manifest['objects'][number];

const policyFor = (manifest: Manifest, id: string) =>
  Object.hasOwn(manifest.policies, id) ? manifest.policies[id] : undefined;

/** The object type when the actor's roles may read it; record rules still apply. */
export function readableObject(
  manifest: Manifest,
  principal: Principal,
  id: string | undefined,
): ManifestObject | undefined {
  const object =
    id === undefined ? undefined : manifest.objects.find((o) => o.id === id);

  return object && allowsObject(principal, policyFor(manifest, object.id))
    ? object
    : undefined;
}

/**
 * Properties of a readable object the actor's roles may read. A reference to a
 * type the actor cannot read is omitted, so its target is never named.
 * Discovery and filters share this set.
 */
export function readableProperties(
  manifest: Manifest,
  principal: Principal,
  object: ManifestObject,
) {
  const policy = policyFor(manifest, object.id);

  if (!policy || !allowsObject(principal, policy)) return [];

  return object.properties.flatMap((property) => {
    if (!allowsField(principal, policy, property.access)) return [];

    const referenceId =
      property.origin.kind === 'reference' ||
      property.origin.kind === 'native-reference'
        ? property.origin.targetObjectDefinitionId
        : undefined;
    const target = readableObject(manifest, principal, referenceId);

    if (referenceId && !target) return [];

    return [{ property, ...(target ? { target } : {}) }];
  });
}

/** The properties a `where` may name: readable ones, with their operand type names. */
export function filterableProperties(
  manifest: Manifest,
  principal: Principal,
  object: ManifestObject,
) {
  return readableProperties(manifest, principal, object).map(
    ({ property, target }) => ({
      id: property.id,
      name: property.name,
      schema: property.schema,
      references:
        target?.apiName ??
        (property.origin.kind === 'object-id' ? object.apiName : undefined),
    }),
  );
}

/**
 * How errors name an object type: its API name once the actor may read it,
 * otherwise the definition ID the caller supplied. An error never resolves a
 * name the actor's discovery would not show.
 */
export function visibleName(
  manifest: Manifest,
  principal: Principal,
  objectDefinitionId: string,
): string {
  return (
    readableObject(manifest, principal, objectDefinitionId)?.apiName ??
    objectDefinitionId
  );
}

/** The caller-facing operation name, such as `Person.query`. */
export function operationName(
  manifest: Manifest,
  principal: Principal,
  objectDefinitionId: string,
  operation: string,
): string {
  return `${visibleName(manifest, principal, objectDefinitionId)}.${operation}`;
}
