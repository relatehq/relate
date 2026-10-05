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
      definitionId: string;
      idField: string;
      fields: Record<string, ScalarSchema>;
    }
  >();

  for (const object of graph.objects) {
    const resource = object.membership.resource;

    // Object-level refinements would otherwise be lost during field extraction.
    if (resource.schema.def.checks?.length || resource.schema.def.catchall)
      throw new Error('Unsupported source record refinement');

    const compiled = {
      definitionId: resource.definitionId,
      idField: resource.idField,
      fields: Object.fromEntries(
        Object.entries(resource.schema.shape).map(([name, schema]) => [
          name,
          portable(schema),
        ]),
      ),
    };
    const prior = resources.get(resource.definitionId);

    if (prior && canonicalJson(prior) !== canonicalJson(compiled))
      throw new Error('Conflicting source definitions');

    resources.set(resource.definitionId, compiled);
  }

  const manifest = validateManifest({
    formatVersion: 1,
    graphDefinitionId: graph.definitionId,
    fieldGroups: [...graph.fieldGroups].sort(),
    sources: [...resources.values()].sort((a, b) =>
      a.definitionId < b.definitionId
        ? -1
        : a.definitionId > b.definitionId
          ? 1
          : 0,
    ),
    objects: graph.objects
      .map((o) => ({
        definitionId: o.definitionId,
        name: o.name,
        sourceDefinitionId: o.membership.resource.definitionId,
        properties: Object.entries(o.properties)
          .map(([name, p]) => ({
            definitionId: p.definitionId,
            name,
            access: p.access,
            schema: portable(p.schema),
            origin: p.origin,
          }))
          .sort((a, b) =>
            a.definitionId < b.definitionId
              ? -1
              : a.definitionId > b.definitionId
                ? 1
                : 0,
          ),
      }))
      .sort((a, b) =>
        a.definitionId < b.definitionId
          ? -1
          : a.definitionId > b.definitionId
            ? 1
            : 0,
      ),
    policies: graph.policies,
  });

  return deepFreeze({
    manifest,
    definitionRevision: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`,
  });
}
