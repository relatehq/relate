import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type {
  GraphDefinition,
  ObjectDefinition,
  ObjectRegistry,
  Property,
} from './index.js';
import type { Claim } from './authorization.js';
import { canonicalJson, deepFreeze, validateManifest } from './model.js';
import type { CompiledModel, ScalarSchema } from './model.js';

// Deliberately narrow: never silently erase refinements, transforms, or defaults.
function portable(schema: z.ZodType): ScalarSchema {
  let current = schema;
  let optional = false;
  let nullable = false;

  while (current.def.type === 'optional' || current.def.type === 'nullable') {
    if ('checks' in current.def && current.def.checks?.length)
      throw new Error('Unsupported schema refinement');

    if (current.def.type === 'optional') optional = true;
    else nullable = true;

    current = (current as z.ZodOptional | z.ZodNullable).unwrap() as z.ZodType;
  }

  const type = current.def.type;

  if (
    !['string', 'number', 'boolean'].includes(type) ||
    ('checks' in current.def && current.def.checks?.length)
  ) {
    throw new Error(
      `Unsupported schema: ${type}. This slice supports unrefined scalar fields only.`,
    );
  }

  return { type: type as ScalarSchema['type'], optional, nullable };
}

function paths(
  objects: ObjectRegistry,
  object: ObjectDefinition,
  input: unknown,
  path: readonly Property[] = [],
): readonly { readonly path: readonly Property[]; readonly claim: Claim }[] {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Object.keys(input).length ||
    path.length >= 16
  )
    throw new Error('Invalid policy predicate');

  return Object.entries(input).flatMap(([name, value]) => {
    const property = Object.hasOwn(object.properties, name)
      ? object.properties[name]
      : undefined;

    if (!property) throw new Error('Unknown policy dependency');

    const next = [...path, property];

    if (property.origin.kind === 'reference') {
      const targetId = property.origin.targetObjectDefinitionId;
      const target = Object.values(objects).find((o) => o.id === targetId);

      if (!target)
        throw new Error('Unknown reference target in policy registry');

      return paths(objects, target, value, next);
    }

    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 1 ||
      !('eq' in value) ||
      !value.eq ||
      typeof value.eq !== 'object' ||
      !('kind' in value.eq) ||
      value.eq.kind !== 'claim'
    )
      throw new Error('Invalid policy predicate');

    return [{ path: next, claim: value.eq as Claim }];
  });
}

export function compile(graph: GraphDefinition): CompiledModel {
  if (Array.isArray(graph.objects) || Array.isArray(graph.policies))
    throw new Error('Objects and policies must be keyed registries');

  // Registry names are consumer API names; stable definition IDs own persistence.
  const objects = Object.values(graph.objects);
  const resources = new Map<
    string,
    {
      id: string;
      idField: string;
      fields: Record<string, ScalarSchema>;
    }
  >();

  for (const object of objects) {
    if (
      Object.values(object.properties).some(
        (property) =>
          property.access !== undefined &&
          property.access?.kind !== 'field-group',
      )
    )
      throw new Error('Invalid field group reference');

    const resource = object.membership.resource;

    // Object-level refinements would otherwise be lost during field extraction.
    if (resource.schema.def.checks?.length || resource.schema.def.catchall)
      throw new Error('Unsupported source record refinement');

    const compiled = {
      id: resource.id,
      idField: resource.idField,
      fields: Object.fromEntries(
        Object.entries(resource.schema.shape).map(([name, schema]) => [
          name,
          portable(schema),
        ]),
      ),
    };
    const prior = resources.get(resource.id);

    if (prior && canonicalJson(prior) !== canonicalJson(compiled))
      throw new Error('Conflicting source definitions');

    resources.set(resource.id, compiled);
  }

  const objectIds = new Set<string>();

  for (const [name, object] of Object.entries(graph.objects)) {
    if (objectIds.has(object.id))
      throw new Error('Duplicate object definition');

    objectIds.add(object.id);

    if (!Object.hasOwn(graph.policies, name))
      throw new Error(`Missing policy: ${name}`);
  }

  const policies = Object.fromEntries(
    Object.entries(graph.policies).flatMap(([name, policy]) => {
      if (!Object.hasOwn(graph.objects, name))
        throw new Error('Unknown policy object');

      const object = graph.objects[name]!;

      if (
        !policy ||
        typeof policy !== 'object' ||
        Object.keys(policy).some((key) => key !== 'read' && key !== 'groups')
      )
        throw new Error('Unsupported policy');

      // Explicit authoring denial uses the portable manifest's existing default-deny contract.
      if (policy.read === 'deny') {
        if (Object.hasOwn(policy, 'groups'))
          throw new Error('Denied reads cannot grant field groups');

        return [];
      }

      const read = policy.read;

      if (
        !read ||
        typeof read !== 'object' ||
        Object.keys(read).some(
          (key) => !['gate', 'where', 'evidenceMaxAgeMs'].includes(key),
        )
      )
        throw new Error('Invalid policy read rule');

      if (
        [read.gate, ...Object.values(policy.groups ?? {})].some(
          (gate) => gate?.kind !== 'role',
        )
      )
        throw new Error('Unsupported policy gate');

      const hasWhere = Object.hasOwn(read, 'where');

      if (
        hasWhere
          ? typeof read.evidenceMaxAgeMs !== 'number'
          : Object.hasOwn(read, 'evidenceMaxAgeMs')
      )
        throw new Error(
          'Predicates require an evidence bound; role-only rules omit it',
        );

      const conditions = hasWhere
        ? paths(graph.objects, object, read.where)
        : undefined;

      for (const condition of conditions ?? []) {
        const claim = Object.hasOwn(graph.access.claims, condition.claim.name)
          ? graph.access.claims[condition.claim.name]
          : undefined;

        if (!claim) throw new Error('Unknown policy claim');

        if (
          canonicalJson(portable(claim.schema)) !==
          canonicalJson(portable(condition.claim.schema))
        )
          throw new Error('Conflicting policy reference');
      }

      return [
        [
          object.id,
          {
            read: {
              role: read.gate.role,
              ...(conditions
                ? {
                    where: {
                      all: conditions.map(({ path, claim }) => ({
                        path: path.map((p) => p.id),
                        claim: claim.name,
                      })),
                    },
                  }
                : {}),
              evidenceMaxAgeMs: read.evidenceMaxAgeMs ?? 0,
            },
            groups: Object.fromEntries(
              Object.entries(policy.groups ?? {}).map(([name, gate]) => [
                name,
                { role: gate!.role },
              ]),
            ),
          },
        ],
      ];
    }),
  );

  const relationships = Object.values(graph.relationships ?? {});

  for (const relationship of relationships) {
    if (
      !objects.includes(relationship.from) ||
      !objects.includes(relationship.to) ||
      !Object.values(relationship.to.properties).includes(relationship.via)
    )
      throw new Error('Unregistered relationship endpoint or reference');
  }

  const manifest = validateManifest({
    formatVersion: 1,
    graphDefinitionId: graph.id,
    fieldGroups: [...graph.access.fieldGroups].sort(),
    roles: [...graph.access.roles].sort(),
    claims: Object.fromEntries(
      Object.entries(graph.access.claims).map(([name, claim]) => [
        name,
        portable(claim.schema),
      ]),
    ),
    sources: [...resources.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    ),
    objects: objects
      .map((o) => ({
        id: o.id,
        name: o.name,
        sourceDefinitionId: o.membership.resource.id,
        properties: Object.entries(o.properties)
          .map(([name, p]) => ({
            id: p.id,
            name,
            access: p.access === undefined ? 'ordinary' : p.access.name,
            schema: portable(p.schema),
            origin: p.origin,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ...(relationships.length
      ? {
          relationships: relationships
            .map((r) => ({
              id: r.id,
              fromObjectDefinitionId: r.from.id,
              toObjectDefinitionId: r.to.id,
              referencePropertyDefinitionId: r.via.id,
              forward: r.forward,
              reverse: r.reverse,
            }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        }
      : {}),
    policies,
  });

  return deepFreeze({
    manifest,
    definitionRevision: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`,
  });
}
