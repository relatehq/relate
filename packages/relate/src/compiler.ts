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
  const resources = new Map<
    string,
    {
      id: string;
      idField: string;
      fields: Record<string, ScalarSchema>;
    }
  >();

  for (const object of graph.objects) {
    if (
      Object.values(object.properties).some(
        (property) => property.access?.kind !== 'field-group',
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

    const object = graph.objects.find((o) => o.id === policy.object.id);

    if (!object) throw new Error('Unknown policy object');

    if (policyObjects.has(object.id))
      throw new Error('Duplicate policy object');

    policyObjects.add(object.id);
    const where = policy.read.where;

    if (where) {
      if (where.kind !== 'equals' || where.claim.kind !== 'claim')
        throw new Error('Unsupported policy predicate');

      const property = Object.values(object.properties).find(
        (p) => p.id === where.property.id,
      );
      const claim = graph.access.claims[where.claim.name];

      if (!property) throw new Error('Unknown policy dependency');

      if (!claim) throw new Error('Unknown policy claim');

      if (
        canonicalJson(portable(property.schema)) !==
          canonicalJson(portable(where.property.schema)) ||
        canonicalJson(portable(claim.schema)) !==
          canonicalJson(portable(where.claim.schema))
      )
        throw new Error('Conflicting policy reference');
    }
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
    objects: graph.objects
      .map((o) => ({
        id: o.id,
        name: o.name,
        sourceDefinitionId: o.membership.resource.id,
        properties: Object.entries(o.properties)
          .map(([name, p]) => ({
            id: p.id,
            name,
            access: p.access.name,
            schema: portable(p.schema),
            origin: p.origin,
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    policies: Object.fromEntries(
      graph.policies.map((policy) => [
        policy.object.id,
        {
          read: {
            role: policy.read.gate.role,
            ...(policy.read.where
              ? {
                  where: {
                    propertyDefinitionId: policy.read.where.property.id,
                    claim: policy.read.where.claim.name,
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
