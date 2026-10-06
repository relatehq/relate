import { accepts } from 'relate/model';
import type { Manifest, Policy } from 'relate/model';
import type { StoredObject } from '../storage.js';

export interface Principal {
  readonly id: string;
  readonly roles: readonly string[];
  readonly claims: Readonly<Record<string, string | number | boolean | null>>;
}

export function allowsObject(
  principal: Principal,
  policy: Policy,
  object: Manifest['objects'][number],
  candidate: StoredObject,
  now: number,
  claims: Manifest['claims'],
): boolean {
  if (
    !principal.roles.includes(policy.read.role) ||
    candidate.observation.state !== 'present'
  )
    return false;

  const condition = policy.read.where;

  if (!condition) return true;

  const property = object.properties.find(
    (p) => p.id === condition.propertyDefinitionId,
  )!;

  if (
    property.origin.kind === 'source' &&
    (now < candidate.observation.observedAt ||
      now - candidate.observation.observedAt > policy.read.evidenceMaxAgeMs)
  )
    return false;

  const value =
    property.origin.kind === 'object-id'
      ? candidate.objectId
      : candidate.observation.values[property.name];

  return (
    Object.hasOwn(principal.claims, condition.claim) &&
    principal.claims[condition.claim] !== undefined &&
    accepts(claims[condition.claim]!, principal.claims[condition.claim]) &&
    value === principal.claims[condition.claim]
  );
}

export function allowsField(
  principal: Principal,
  policy: Policy,
  access: string,
): boolean {
  return (
    access === 'ordinary' ||
    (Object.hasOwn(policy.groups, access) &&
      principal.roles.includes(policy.groups[access]!.role))
  );
}
