import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { GraphDefinition } from './index.js';
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

export function compile(graph: GraphDefinition): CompiledModel {
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

  const policyObjects = new Set<string>();

  for (const policy of graph.policies) {
    if (
      [policy.read.gate, ...Object.values(policy.groups)].some(
        (gate) => gate.kind !== 'role',
      )
    )
      throw new Error('Unsupported policy gate');

    const object = objects.find((o) => o.id === policy.object.id);

    if (!object) throw new Error('Unknown policy object');

    if (policyObjects.has(object.id))
      throw new Error('Duplicate policy object');

    policyObjects.add(object.id);
    const where = policy.read.where;

    if (where) {
      const conditions =
        where.kind === 'all'
          ? where.conditions
          : where.kind === 'equals'
            ? [{ path: [where.property], claim: where.claim }]
            : [];

      if (!conditions.length) throw new Error('Unsupported policy predicate');

      for (const condition of conditions) {
        let current = object;

        for (const [index, reference] of condition.path.entries()) {
          const property = Object.values(current.properties).find(
            (p) => p.id === reference.id,
          );

          if (!property) throw new Error('Unknown policy dependency');

          if (
            canonicalJson(property.origin) !==
              canonicalJson(reference.origin) ||
            canonicalJson(portable(property.schema)) !==
              canonicalJson(portable(reference.schema))
          )
            throw new Error('Conflicting policy reference');

          if (index < condition.path.length - 1) {
            if (property.origin.kind !== 'reference')
              throw new Error('Invalid policy path');

            const targetId = property.origin.targetObjectDefinitionId;
            const target = objects.find((o) => o.id === targetId);

            if (!target) throw new Error('Unknown reference target');

            current = target;
          }
        }

        const claim = graph.access.claims[condition.claim.name];

        if (condition.claim.kind !== 'claim')
          throw new Error('Unsupported policy predicate');

        if (!claim) throw new Error('Unknown policy claim');

        if (
          canonicalJson(portable(claim.schema)) !==
          canonicalJson(portable(condition.claim.schema))
        )
          throw new Error('Conflicting policy reference');
      }
    }
  }

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
    policies: Object.fromEntries(
      graph.policies.map((policy) => [
        policy.object.id,
        {
          read: {
            role: policy.read.gate.role,
            ...(policy.read.where
              ? {
                  where:
                    policy.read.where.kind === 'equals'
                      ? {
                          propertyDefinitionId: policy.read.where.property.id,
                          claim: policy.read.where.claim.name,
                        }
                      : {
                          all: policy.read.where.conditions.map(
                            (condition) => ({
                              path: condition.path.map((p) => p.id),
                              claim: condition.claim.name,
                            }),
                          ),
                        },
                }
              : {}),
            evidenceMaxAgeMs: policy.read.evidenceMaxAgeMs,
          },
          groups: Object.fromEntries(
            Object.entries(policy.groups).map(([name, gate]) => [
              name,
              { role: gate.role },
            ]),
          ),
        },
      ]),
    ),
  });

  return deepFreeze({
    manifest,
    definitionRevision: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`,
  });
}
