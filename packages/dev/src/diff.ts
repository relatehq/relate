/**
 * Typed Manifest diffs and the bounded terminal summary. Shared by the SSE
 * adapter and the terminal renderer so neither parses the other's output.
 */
import { canonicalJson } from 'relate/model';
import type { Manifest } from 'relate/model';
import type { ManifestDiff } from '@relate/inspector/protocol';

type ManifestObject = Manifest['objects'][number];

function compareCollections<T extends { readonly id: string }>(
  previous: readonly T[],
  next: readonly T[],
): { added: string[]; changed: string[]; removed: string[] } {
  const before = new Map(previous.map((item) => [item.id, item] as const));
  const after = new Map(next.map((item) => [item.id, item] as const));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [id, item] of after) {
    const prior = before.get(id);

    if (!prior) added.push(id);
    else if (canonicalJson(prior) !== canonicalJson(item)) changed.push(id);
  }

  for (const id of before.keys()) if (!after.has(id)) removed.push(id);

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}

export function diffManifests(
  previous: Manifest | null,
  next: Manifest,
): ManifestDiff {
  const objects = compareCollections(previous?.objects ?? [], next.objects);
  const relationships = compareCollections(
    previous?.relationships ?? [],
    next.relationships ?? [],
  );
  const rest = (manifest: Manifest | null) => {
    if (!manifest) return null;

    const { objects: _o, relationships: _r, ...other } = manifest;

    void _o;
    void _r;

    return canonicalJson(other);
  };

  return {
    objects,
    relationships,
    otherChanged: rest(previous) !== rest(next),
  };
}

function displayName(
  id: string,
  ...manifests: readonly (Manifest | null)[]
): string {
  for (const manifest of manifests) {
    const object = manifest?.objects.find((o) => o.id === id);

    if (object) return object.apiName;

    const relationship = manifest?.relationships?.find((r) => r.id === id);

    if (relationship) {
      const from = manifest?.objects.find(
        (o) => o.id === relationship.fromObjectDefinitionId,
      );

      return `${from?.apiName ?? relationship.fromObjectDefinitionId}.${relationship.forward.name}`;
    }
  }

  return id;
}

function propertyChanges(
  previous: ManifestObject,
  next: ManifestObject,
): string[] {
  const before = new Map(previous.properties.map((p) => [p.id, p] as const));
  const after = new Map(next.properties.map((p) => [p.id, p] as const));
  const changes: string[] = [];

  for (const [id, property] of after) {
    const prior = before.get(id);

    if (!prior) changes.push(`+${next.apiName}.${property.name}`);
    else if (canonicalJson(prior) !== canonicalJson(property))
      changes.push(`~${next.apiName}.${property.name}`);
  }

  for (const [id, property] of before)
    if (!after.has(id)) changes.push(`-${next.apiName}.${property.name}`);

  return changes;
}

function otherSections(previous: Manifest, next: Manifest): string[] {
  const changes: string[] = [];
  const policies = new Set([
    ...Object.keys(previous.policies),
    ...Object.keys(next.policies),
    ...Object.keys(previous.createPolicies ?? {}),
    ...Object.keys(next.createPolicies ?? {}),
  ]);

  for (const id of [...policies].sort()) {
    const name = displayName(id, next, previous);
    const before = canonicalJson([
      previous.policies[id] ?? null,
      previous.createPolicies?.[id] ?? null,
    ]);
    const after = canonicalJson([
      next.policies[id] ?? null,
      next.createPolicies?.[id] ?? null,
    ]);

    if (before !== after) changes.push(`~policy ${name}`);
  }

  for (const { added, changed, removed } of [
    compareCollections(previous.sources, next.sources),
  ]) {
    changes.push(...added.map((id) => `+source ${id}`));
    changes.push(...changed.map((id) => `~source ${id}`));
    changes.push(...removed.map((id) => `-source ${id}`));
  }

  const actions = compareCollections(
    previous.actions ?? [],
    next.actions ?? [],
  );
  const actionName = (id: string) =>
    (next.actions ?? previous.actions ?? []).find((a) => a.id === id)
      ?.apiName ?? id;

  changes.push(...actions.added.map((id) => `+action ${actionName(id)}`));
  changes.push(...actions.changed.map((id) => `~action ${actionName(id)}`));
  changes.push(...actions.removed.map((id) => `-action ${actionName(id)}`));

  if (
    canonicalJson([previous.roles, previous.fieldGroups, previous.claims]) !==
    canonicalJson([next.roles, next.fieldGroups, next.claims])
  )
    changes.push('~access');

  if (previous.graphDefinitionId !== next.graphDefinitionId)
    changes.push(`~graph ${next.graphDefinitionId}`);

  return changes;
}

/**
 * At most three changes, then `(+N changes)`. `+`, `~` and `-` mark additions,
 * changes and removals; names come from stable IDs in the old and new manifests.
 */
export function summarizeDiff(
  previous: Manifest | null,
  next: Manifest,
  diff: ManifestDiff = diffManifests(previous, next),
  limit = 3,
): string {
  if (previous && canonicalJson(previous) === canonicalJson(next))
    return 'model unchanged';

  const changes: string[] = [];

  changes.push(...diff.objects.added.map((id) => `+${displayName(id, next)}`));
  changes.push(
    ...diff.relationships.added.map((id) => `+${displayName(id, next)}`),
  );

  for (const id of diff.objects.changed) {
    const before = previous?.objects.find((o) => o.id === id);
    const after = next.objects.find((o) => o.id === id);
    const properties = before && after ? propertyChanges(before, after) : [];

    changes.push(
      ...(properties.length ? properties : [`~${displayName(id, next)}`]),
    );
  }

  changes.push(
    ...diff.relationships.changed.map((id) => `~${displayName(id, next)}`),
  );
  changes.push(
    ...diff.objects.removed.map((id) => `-${displayName(id, previous)}`),
  );
  changes.push(
    ...diff.relationships.removed.map((id) => `-${displayName(id, previous)}`),
  );

  if (diff.otherChanged && previous)
    changes.push(...otherSections(previous, next));

  if (changes.length === 0)
    return previous ? 'model changed' : `${next.objects.length} objects`;

  const shown = changes.slice(0, limit).join(' ');

  return changes.length > limit
    ? `${shown} (+${changes.length - limit} changes)`
    : shown;
}

/** The banner-style description of an accepted model. */
export function describeManifest(manifest: Manifest): string {
  const count = (n: number, noun: string) =>
    `${n} ${noun}${n === 1 ? '' : 's'}`;

  return `${manifest.graphDefinitionId}  ${count(manifest.objects.length, 'object')} · ${count(manifest.sources.length, 'source')} · ${count(manifest.relationships?.length ?? 0, 'relationship')}`;
}
