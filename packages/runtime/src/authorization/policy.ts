import { accepts } from 'relate/model';
import type { Manifest, Policy } from 'relate/model';
import type { StoredObject } from '../storage.js';

type ObjectType = Manifest['objects'][number];

type Property = ObjectType['properties'][number];

export interface Principal {
  readonly id: string;
  readonly roles: readonly string[];
  readonly claims: Readonly<Record<string, string | number | boolean | null>>;
}

export function conditions(policy: Policy) {
  const where = policy.read.where;

  return !where
    ? []
    : 'all' in where
      ? where.all
      : [{ path: [where.propertyDefinitionId], claim: where.claim }];
}

export interface AuthorizationEvidence {
  readonly candidate: StoredObject;
  readonly permissionCandidate: StoredObject;
}

/** Private evidence evaluation never projects dependency values into the response. */
export function createAuthorization(options: {
  manifest: Manifest;
  principal: Principal;
  clock: () => number;
  resolve(
    object: ObjectType,
    sourceKey: string,
    maxAgeMs: number,
    canonical?: boolean,
  ): Promise<AuthorizationEvidence | undefined>;
}) {
  const { manifest, principal, clock } = options;
  const fresh = (stored: StoredObject, maxAgeMs: number) =>
    stored.observation.state === 'present' &&
    clock() >= stored.observation.observedAt &&
    clock() - stored.observation.observedAt <= maxAgeMs;
  // Request-local only. A stricter bound refreshes and replaces earlier evidence,
  // so a later denial cannot leave a looser cached permission usable.
  const cache = new Map<
    string,
    { age: number; result: Promise<AuthorizationEvidence | undefined> }
  >();
  const resolve = (
    target: ObjectType,
    key: string,
    age: number,
    canonical = false,
  ) => {
    const cacheKey = JSON.stringify([target.id, key, canonical]);
    const previous = cache.get(cacheKey);

    if (!previous || age < previous.age) {
      cache.set(cacheKey, {
        age,
        result: options
          .resolve(target, key, age, canonical)
          .catch(() => undefined),
      });
    }

    return cache.get(cacheKey)!.result;
  };
  const policyFor = (object: ObjectType) =>
    Object.hasOwn(manifest.policies, object.id)
      ? manifest.policies[object.id]
      : undefined;

  async function targetFor(
    property: Property,
    stored: StoredObject,
    age: number,
    authorizeTarget = false,
  ) {
    if (
      (property.origin.kind !== 'reference' &&
        property.origin.kind !== 'native-reference') ||
      (property.origin.kind === 'reference' && !fresh(stored, age))
    )
      return undefined;

    const targetId = property.origin.targetObjectDefinitionId;
    const key = stored.observation.values[property.id];
    const target = manifest.objects.find((o) => o.id === targetId)!;

    if (typeof key !== 'string' || !key.trim()) return undefined;

    const policy = policyFor(target);

    if (authorizeTarget && !allowsObject(principal, policy)) return undefined;

    const evidence = await resolve(
      target,
      key,
      authorizeTarget && policy?.read.where
        ? Math.min(age, policy.read.evidenceMaxAgeMs)
        : age,
      property.origin.kind === 'native-reference',
    );

    return evidence && { target, evidence };
  }

  async function matches(
    object: ObjectType,
    stored: StoredObject,
    path: string[],
    operand: { claim?: string | undefined; actor?: 'id' | undefined },
    age: number,
  ): Promise<boolean> {
    if (stored.observation.state !== 'present') return false;

    const property = object.properties.find((p) => p.id === path[0])!;

    if (
      property.origin.kind === 'reference' ||
      property.origin.kind === 'native-reference'
    ) {
      const resolved = await targetFor(property, stored, age);

      if (!resolved) return false;

      for (const snapshot of new Set([
        resolved.evidence.permissionCandidate,
        resolved.evidence.candidate,
      ])) {
        if (
          !(await matches(
            resolved.target,
            snapshot,
            path.slice(1),
            operand,
            age,
          ))
        )
          return false;
      }

      return true;
    }

    if (
      object.sourceDefinitionId &&
      property.origin.kind !== 'object-id' &&
      !fresh(stored, age)
    )
      return false;

    const value =
      property.origin.kind === 'object-id'
        ? stored.objectId
        : stored.observation.values[property.id];

    if (operand.actor === 'id')
      return value !== undefined && value === principal.id;

    const claim = operand.claim;

    return (
      claim !== undefined &&
      Object.hasOwn(principal.claims, claim) &&
      principal.claims[claim] !== undefined &&
      accepts(manifest.claims[claim]!, principal.claims[claim]) &&
      value !== undefined &&
      value === principal.claims[claim]
    );
  }

  async function allows(
    object: ObjectType,
    evidence: AuthorizationEvidence,
    policy = policyFor(object),
  ): Promise<boolean> {
    if (!allowsObject(principal, policy)) return false;

    for (const stored of new Set([
      evidence.permissionCandidate,
      evidence.candidate,
    ])) {
      if (stored.observation.state !== 'present') return false;

      for (const condition of conditions(policy)) {
        if (
          !(await matches(
            object,
            stored,
            condition.path,
            condition,
            policy.read.evidenceMaxAgeMs,
          ))
        )
          return false;
      }
    }

    return true;
  }

  return {
    allows,
    async reference(
      object: ObjectType,
      evidence: AuthorizationEvidence,
      property: Property,
    ): Promise<string | undefined> {
      const policy = policyFor(object)!;
      // Both the retained and transient references must be authorized. A failed
      // retention cannot introduce an unconfirmed identity into the graph result.
      const retained = await targetFor(
        property,
        evidence.permissionCandidate,
        policy.read.where ? policy.read.evidenceMaxAgeMs : 60_000,
        true,
      );
      const current = await targetFor(
        property,
        evidence.candidate,
        policy.read.where ? policy.read.evidenceMaxAgeMs : 60_000,
        true,
      );

      if (
        !retained ||
        !current ||
        retained.evidence.candidate.objectId !==
          current.evidence.candidate.objectId ||
        !(await allows(retained.target, retained.evidence)) ||
        !(await allows(current.target, current.evidence))
      )
        return undefined;

      return current.evidence.candidate.objectId;
    },
  };
}

/** The role-level read gate; record-level conditions are evaluated per read. */
export function allowsObject(
  principal: Principal,
  policy: Policy | undefined,
): policy is Policy {
  return Boolean(policy && principal.roles.includes(policy.read.role));
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
