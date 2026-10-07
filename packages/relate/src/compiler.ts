import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type {
  GraphDefinition,
  ObjectDefinition,
  ObjectRegistry,
  Property,
} from './index.js';
import { referenceSchemas } from './schema.js';
import type { Claim, ActorField, ObjectRule } from './authorization.js';
import { canonicalJson, deepFreeze, validateManifest } from './model.js';
import type { CompiledModel, ScalarSchema } from './model.js';

// Deliberately narrow: never silently erase refinements, transforms, defaults, or coercion.
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
    ('checks' in current.def && current.def.checks?.length) ||
    // Coercion changes which inputs parse; the portable scalar would accept fewer.
    ('coerce' in current.def && current.def.coerce)
  ) {
    throw new Error(
      `Unsupported schema: ${type}. This slice supports unrefined, uncoerced scalar fields only.`,
    );
  }

  return { type: type as ScalarSchema['type'], optional, nullable };
}

function paths(
  objects: ObjectRegistry,
  object: ObjectDefinition,
  input: unknown,
  path: readonly Property[] = [],
): readonly {
  readonly path: readonly Property[];
  readonly claim: Claim | ActorField;
}[] {
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

    if (
      property.origin.kind === 'reference' ||
      property.origin.kind === 'native-reference'
    ) {
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
      !['claim', 'actor-field'].includes(String(value.eq.kind))
    )
      throw new Error('Invalid policy predicate');

    return [{ path: next, claim: value.eq as Claim | ActorField }];
  });
}

// Presentation only: this value never determines API addressing or identity.
function humanize(apiName: string): string {
  const words = apiName
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
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

    if (!('resource' in object.membership)) {
      if (object.membership.kind !== 'native')
        throw new Error('Unsupported membership');

      continue;
    }

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

  const createPolicies: Record<string, unknown> = {};
  const compileRule = (
    object: ObjectDefinition,
    rule: ObjectRule<string, unknown>,
  ) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      Object.keys(rule).some(
        (key) => !['gate', 'where', 'evidenceMaxAgeMs'].includes(key),
      )
    )
      throw new Error('Invalid policy read rule');

    if (rule.gate?.kind !== 'role') throw new Error('Unsupported policy gate');

    const hasWhere = Object.hasOwn(rule, 'where');

    if (
      hasWhere
        ? typeof rule.evidenceMaxAgeMs !== 'number'
        : Object.hasOwn(rule, 'evidenceMaxAgeMs')
    )
      throw new Error(
        'Predicates require an evidence bound; role-only rules omit it',
      );

    const conditions = hasWhere
      ? paths(graph.objects, object, rule.where)
      : undefined;

    for (const { claim } of conditions ?? []) {
      if (claim.kind === 'actor-field') {
        if (claim.name !== 'id') throw new Error('Unknown actor field');

        continue;
      }

      const declared = Object.hasOwn(graph.access.claims, claim.name)
        ? graph.access.claims[claim.name]
        : undefined;

      if (!declared) throw new Error('Unknown policy claim');

      if (
        canonicalJson(portable(declared.schema)) !==
        canonicalJson(portable(claim.schema))
      )
        throw new Error('Conflicting policy reference');
    }

    return {
      role: rule.gate.role,
      ...(conditions
        ? {
            where: {
              all: conditions.map(({ path, claim }) => ({
                path: path.map((p) => p.id),
                ...(claim.kind === 'actor-field'
                  ? { actor: 'id' }
                  : { claim: claim.name }),
              })),
            },
          }
        : {}),
      evidenceMaxAgeMs: rule.evidenceMaxAgeMs ?? 0,
    };
  };
  const policies = Object.fromEntries(
    Object.entries(graph.policies).flatMap(([name, policy]) => {
      if (!Object.hasOwn(graph.objects, name))
        throw new Error('Unknown policy object');

      const object = graph.objects[name]!;

      if (
        !policy ||
        typeof policy !== 'object' ||
        Object.keys(policy).some(
          (key) => !['read', 'create', 'groups'].includes(key),
        )
      )
        throw new Error('Unsupported policy');

      if (policy.create !== undefined) {
        if ('resource' in object.membership)
          throw new Error('Create policy requires native membership');

        if (policy.create !== 'deny')
          createPolicies[object.id] = compileRule(object, policy.create);
      }

      if (policy.read === 'deny') {
        if (Object.hasOwn(policy, 'groups'))
          throw new Error('Denied reads cannot grant field groups');

        return [];
      }

      if (
        Object.values(policy.groups ?? {}).some((gate) => gate?.kind !== 'role')
      )
        throw new Error('Unsupported policy gate');

      return [
        [
          object.id,
          {
            read: compileRule(object, policy.read),
            groups: Object.fromEntries(
              Object.entries(policy.groups ?? {}).map(([group, gate]) => [
                group,
                { role: gate!.role },
              ]),
            ),
          },
        ],
      ];
    }),
  );

  const actionShape = (schema: z.ZodType) => {
    if (
      schema.def.type !== 'object' ||
      ('checks' in schema.def && schema.def.checks?.length) ||
      (schema as z.ZodObject).def.catchall
    )
      throw new Error(
        'Actions require unrefined object schemas with scalar fields in this slice',
      );

    return Object.fromEntries(
      Object.entries((schema as z.ZodObject).shape).map(([name, field]) => {
        const references = referenceSchemas.get(field);

        return [
          name,
          references
            ? { type: 'string', nullable: false, optional: false, references }
            : portable(field),
        ];
      }),
    );
  };
  const actions = Object.entries(graph.actions ?? {}).map(
    ([apiName, action]) => {
      if (
        Object.keys(action).some(
          (key) =>
            !['id', 'input', 'output', 'creates', 'policy'].includes(key),
        )
      )
        throw new Error('Unsupported action option');

      if (
        action.policy &&
        (Object.keys(action.policy).some((key) => key !== 'execute') ||
          action.policy.execute?.kind !== 'role')
      )
        throw new Error('Unsupported action policy');

      if (action.creates.some((object) => !objects.includes(object)))
        throw new Error('Unregistered action capability');

      return {
        id: action.id,
        apiName,
        input: actionShape(action.input),
        output: actionShape(action.output),
        creates: action.creates.map((o) => o.id).sort(),
        ...(action.policy
          ? { execute: { role: action.policy.execute.role } }
          : {}),
      };
    },
  );

  actions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const relationships = Object.values(graph.relationships ?? {});

  for (const relationship of relationships) {
    if (
      !objects.includes(relationship.from) ||
      !objects.includes(relationship.to) ||
      relationship.via.owner !== relationship.to ||
      relationship.via.target !== relationship.from ||
      !Object.values(relationship.to.properties).includes(relationship.via)
    )
      throw new Error('Unregistered relationship endpoint or reference');
  }

  const manifest = validateManifest({
    formatVersion: 2,
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
    objects: Object.entries(graph.objects)
      .map(([apiName, o]) => ({
        id: o.id,
        apiName,
        label: o.label ?? humanize(apiName),
        pluralLabel: o.pluralLabel ?? o.label ?? humanize(apiName),
        ...(o.description !== undefined ? { description: o.description } : {}),
        ...('resource' in o.membership
          ? { sourceDefinitionId: o.membership.resource.id }
          : {}),
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
    ...(Object.keys(createPolicies).length ? { createPolicies } : {}),
    ...(actions.length ? { actions } : {}),
  });

  return deepFreeze({
    manifest,
    definitionRevision: `sha256:${createHash('sha256').update(canonicalJson(manifest)).digest('hex')}`,
  });
}
