import { z } from 'zod';
import type { ScalarSchema } from '@relate/protocol';
import { ManifestValidationError } from './diagnostics.js';
import type { ModelIssue, ModelIssueCode } from './diagnostics.js';

export { ManifestValidationError } from './diagnostics.js';

export type { IssuePath, ModelIssue, ModelIssueCode } from './diagnostics.js';

const text = z.string().min(1);

/** Explanatory text must say something; blank descriptions are authoring mistakes. */
const prose = z.string().regex(/\S/, 'Description must not be blank');

/** The portable shape is declared in `@relate/protocol`; this validator must produce it. */
export const scalarSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  optional: z.boolean(),
  nullable: z.boolean(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  minimum: z.number().finite().optional(),
  maximum: z.number().finite().optional(),
  exclusiveMinimum: z.number().finite().optional(),
  exclusiveMaximum: z.number().finite().optional(),
}) satisfies z.ZodType<ScalarSchema>;

export type { ScalarSchema } from '@relate/protocol';

export const actionFieldSchema = scalarSchema.extend({
  description: prose.optional(),
  references: text.optional(),
});

const roleGate = z.strictObject({ role: text });
const policySchema = z.strictObject({
  read: roleGate.extend({
    where: z
      .union([
        z.strictObject({ propertyDefinitionId: text, claim: text }),
        z.strictObject({
          all: z
            .array(
              z.strictObject({
                path: z.array(text).min(1).max(16),
                claim: text.optional(),
                actor: z.literal('id').optional(),
              }),
            )
            .min(1),
        }),
      ])
      .optional(),
    evidenceMaxAgeMs: z.number().finite().nonnegative(),
  }),
  groups: z.record(text, roleGate),
});

export type Policy = z.infer<typeof policySchema>;

const propertySchema = z.strictObject({
  id: text,
  name: text,
  description: prose.optional(),
  access: text,
  schema: scalarSchema,
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('native') }),
    z.strictObject({
      kind: z.literal('native-reference'),
      targetObjectDefinitionId: text,
    }),
    z.strictObject({
      kind: z.literal('reference'),
      sourceDefinitionId: text,
      field: text,
      targetObjectDefinitionId: text,
    }),
    z.strictObject({ kind: z.literal('object-id') }),
    z.strictObject({
      kind: z.literal('source'),
      sourceDefinitionId: text,
      field: text,
    }),
  ]),
});

export const manifestSchema = z.strictObject({
  formatVersion: z.literal(5),
  graphDefinitionId: text,
  description: prose.optional(),
  fieldGroups: z.array(text),
  roles: z.array(text),
  claims: z.record(text, scalarSchema),
  sources: z.array(
    z.strictObject({
      id: text,
      idField: text,
      fields: z.record(text, scalarSchema),
    }),
  ),
  objects: z.array(
    z.strictObject({
      id: text,
      apiName: text,
      label: text.refine((value) => value.trim().length > 0),
      pluralLabel: text.refine((value) => value.trim().length > 0),
      description: prose.optional(),
      sourceDefinitionId: text.optional(),
      properties: z.array(propertySchema),
    }),
  ),
  relationships: z
    .array(
      z.union([
        z.strictObject({
          id: text,
          fromObjectDefinitionId: text,
          toObjectDefinitionId: text,
          referencePropertyDefinitionId: text,
          forward: z.strictObject({
            name: text,
            cardinality: z.literal('many'),
            description: prose.optional(),
          }),
          reverse: z.strictObject({
            name: text,
            cardinality: z.literal('one'),
            description: prose.optional(),
          }),
        }),
        z.strictObject({
          id: text,
          fromObjectDefinitionId: text,
          toObjectDefinitionId: text,
          through: z.strictObject({
            objectDefinitionId: text,
            fromReferencePropertyDefinitionId: text,
            toReferencePropertyDefinitionId: text,
          }),
          forward: z.strictObject({
            name: text,
            cardinality: z.literal('many'),
            description: prose.optional(),
          }),
          reverse: z.strictObject({
            name: text,
            cardinality: z.literal('many'),
            description: prose.optional(),
          }),
        }),
      ]),
    )
    .optional(),
  policies: z.record(text, policySchema),
  createPolicies: z.record(text, policySchema.shape.read).optional(),
  actions: z
    .array(
      z.strictObject({
        id: text,
        apiName: text,
        description: prose.optional(),
        input: z.record(text, actionFieldSchema),
        output: z.record(text, actionFieldSchema),
        errors: z.record(text, z.record(text, actionFieldSchema)).optional(),
        creates: z.array(text),
        execute: roleGate.optional(),
      }),
    )
    .optional(),
});

export type Manifest = z.infer<typeof manifestSchema>;

export interface CompiledModel {
  readonly manifest: Manifest;
  readonly definitionRevision: string;
}

/**
 * True for a plain data object (`{...}` or `Object.create(null)`) and false for
 * arrays, class instances, Map, Date and other built-ins.
 *
 * Why not `Object.getPrototypeOf(value) === Object.prototype`: every JavaScript
 * realm (a `node:vm` context, an iframe, jsdom, an agent REPL sandbox) has its
 * own `Object.prototype`. An object literal written in another realm is just as
 * plain, but the identity check rejects it, so callers running in a sandbox saw
 * valid action inputs and query filters fail as invalid. Instead we check the
 * shape of the chain: only a realm's `Object.prototype` has a null prototype,
 * while a class instance's prototype (`Foo.prototype`) inherits from it.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  // Rejects arrays and built-ins (Map, Date, RegExp, ...) from any realm.
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }

  const encoded = JSON.stringify(value);

  if (encoded === undefined) throw new Error('Non-JSON value');

  return encoded;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);

    Object.freeze(value);
  }

  return value;
}

export function accepts(schema: ScalarSchema, value: unknown): boolean {
  if (value === undefined) return schema.optional;

  if (value === null) return schema.nullable;

  if (typeof value !== schema.type) return false;

  if (typeof value === 'string') {
    if (schema.minLength === undefined && schema.maxLength === undefined)
      return true;

    // Zod 4.6 string lengths count Unicode code points, including astral characters.
    const length = [...value].length;

    return (
      (schema.minLength === undefined || length >= schema.minLength) &&
      (schema.maxLength === undefined || length <= schema.maxLength)
    );
  }

  if (typeof value === 'number')
    return (
      Number.isFinite(value) &&
      (schema.minimum === undefined || value >= schema.minimum) &&
      (schema.maximum === undefined || value <= schema.maximum) &&
      (schema.exclusiveMinimum === undefined ||
        value > schema.exclusiveMinimum) &&
      (schema.exclusiveMaximum === undefined || value < schema.exclusiveMaximum)
    );

  return true;
}

const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

type Segment = string | number;

class Issues {
  readonly list: ModelIssue[] = [];

  report(
    code: ModelIssueCode,
    message: string,
    segments: readonly Segment[],
    definitionId?: string,
  ): void {
    this.list.push({
      code,
      message,
      ...(definitionId !== undefined ? { definitionId } : {}),
      path: { root: 'manifest', segments: [...segments] },
    });
  }
}

function describeShapeIssue(issue: z.core.$ZodIssue): string {
  const location = issue.path.length
    ? issue.path.map(String).join('.')
    : 'manifest';

  return `Invalid manifest shape at ${location}: ${issue.message}`;
}

/**
 * Validate serialized manifest input. Throws `ManifestValidationError` with
 * every independent issue found; dependent checks are skipped once their
 * prerequisite fails so one mistake does not cascade.
 */
export function validateManifest(input: unknown): Manifest {
  const parsed = manifestSchema.safeParse(input);

  if (!parsed.success)
    throw new ManifestValidationError(
      parsed.error.issues.map((issue) => ({
        code: 'manifest.invalid-shape',
        message: describeShapeIssue(issue),
        path: {
          root: 'manifest',
          segments: issue.path.map((segment) =>
            typeof segment === 'symbol' ? String(segment) : segment,
          ),
        },
      })),
    );

  const manifest = parsed.data;
  const issues = new Issues();
  // Validate type-specific constraint metadata on every schema, including loaded JSON.
  const scalars: {
    schema: ScalarSchema;
    path: Segment[];
    definitionId?: string;
  }[] = [
    ...Object.entries(manifest.claims).map(([name, schema]) => ({
      schema,
      path: ['claims', name],
    })),
    ...manifest.sources.flatMap((source, index) =>
      Object.entries(source.fields).map(([name, schema]) => ({
        schema,
        path: ['sources', index, 'fields', name],
        definitionId: source.id,
      })),
    ),
    ...manifest.objects.flatMap((object, index) =>
      object.properties.map((property, propertyIndex) => ({
        schema: property.schema,
        path: ['objects', index, 'properties', propertyIndex, 'schema'],
        definitionId: object.id,
      })),
    ),
    ...(manifest.actions ?? []).flatMap((action, index) => [
      ...Object.entries(action.input).map(([name, schema]) => ({
        schema,
        path: ['actions', index, 'input', name],
        definitionId: action.id,
      })),
      ...Object.entries(action.output).map(([name, schema]) => ({
        schema,
        path: ['actions', index, 'output', name],
        definitionId: action.id,
      })),
      ...Object.entries(action.errors ?? {}).flatMap(([code, shape]) =>
        Object.entries(shape).map(([name, schema]) => ({
          schema,
          path: ['actions', index, 'errors', code, name],
          definitionId: action.id,
        })),
      ),
    ]),
  ];

  for (const { schema, path, definitionId } of scalars) {
    if (
      (schema.type !== 'string' &&
        (schema.minLength !== undefined || schema.maxLength !== undefined)) ||
      (schema.type !== 'number' &&
        [
          schema.minimum,
          schema.maximum,
          schema.exclusiveMinimum,
          schema.exclusiveMaximum,
        ].some((v) => v !== undefined))
    )
      issues.report(
        'schema.unsupported',
        'Constraint does not match scalar type',
        path,
        definitionId,
      );

    if (
      schema.type === 'string' &&
      (schema.minLength ?? 0) > (schema.maxLength ?? Infinity)
    )
      issues.report(
        'schema.unsupported',
        'Unsatisfiable string bounds',
        path,
        definitionId,
      );

    if (schema.type === 'number') {
      const lower = Math.max(
        schema.minimum ?? -Infinity,
        schema.exclusiveMinimum ?? -Infinity,
      );
      const upper = Math.min(
        schema.maximum ?? Infinity,
        schema.exclusiveMaximum ?? Infinity,
      );

      if (
        lower > upper ||
        (lower === upper &&
          (schema.exclusiveMinimum === lower ||
            schema.exclusiveMaximum === upper))
      )
        issues.report(
          'schema.unsupported',
          'Unsatisfiable number bounds',
          path,
          definitionId,
        );
    }
  }

  const seen = new Set<string>();
  const register = (value: string, segments: readonly Segment[]): boolean => {
    if (!value.trim() || unsafe.has(value)) {
      issues.report(
        'definition.invalid-id',
        `Invalid definition ID '${value}'`,
        segments,
      );

      return false;
    }

    if (seen.has(value)) {
      issues.report(
        'definition.duplicate-id',
        `Invalid or duplicate definition ID: ${value}`,
        segments,
        value,
      );

      return false;
    }

    seen.add(value);

    return true;
  };

  register(manifest.graphDefinitionId, ['graphDefinitionId']);

  if (
    !manifest.fieldGroups.includes('ordinary') ||
    new Set(manifest.fieldGroups).size !== manifest.fieldGroups.length ||
    manifest.fieldGroups.some((g) => unsafe.has(g))
  )
    issues.report(
      'access.invalid-field-groups',
      `Invalid field groups: expected unique names including 'ordinary', found ${JSON.stringify(manifest.fieldGroups)}`,
      ['fieldGroups'],
    );

  if (
    new Set(manifest.roles).size !== manifest.roles.length ||
    manifest.roles.some((role) => !role.trim() || unsafe.has(role))
  )
    issues.report(
      'access.invalid-roles',
      `Invalid roles: expected unique nonblank names, found ${JSON.stringify(manifest.roles)}`,
      ['roles'],
    );

  for (const name of Object.keys(manifest.claims))
    if (!name.trim() || unsafe.has(name))
      issues.report(
        'access.invalid-claims',
        `Invalid claims: claim name '${name}' is not allowed`,
        ['claims', name],
      );

  manifest.sources.forEach((resource, index) => {
    register(resource.id, ['sources', index, 'id']);
    const key = resource.fields[resource.idField];

    if (!key || key.type !== 'string' || key.optional || key.nullable)
      issues.report(
        'source.invalid-id-field',
        `Source idField must be a required string: source '${resource.id}' field '${resource.idField}'`,
        ['sources', index, 'idField'],
        resource.id,
      );

    for (const field of Object.keys(resource.fields))
      if (unsafe.has(field))
        issues.report(
          'source.invalid-field',
          `Unsafe source field '${field}' on source '${resource.id}'`,
          ['sources', index, 'fields', field],
          resource.id,
        );
  });

  const names = new Set<string>();
  const objectById = new Map(manifest.objects.map((o) => [o.id, o] as const));

  manifest.objects.forEach((object, index) => {
    const at = (...segments: Segment[]) => ['objects', index, ...segments];

    register(object.id, at('id'));

    if (
      !object.apiName.trim() ||
      unsafe.has(object.apiName) ||
      names.has(object.apiName)
    )
      issues.report(
        'object.invalid-api-name',
        `Invalid or duplicate object API name '${object.apiName}' for object '${object.id}'`,
        at('apiName'),
        object.id,
      );

    names.add(object.apiName);
    const resource = manifest.sources.find(
      (s) => s.id === object.sourceDefinitionId,
    );

    if (object.sourceDefinitionId && !resource) {
      issues.report(
        'object.unknown-source',
        `Unknown membership source '${object.sourceDefinitionId}' for object ${object.apiName}`,
        at('sourceDefinitionId'),
        object.id,
      );

      // Property checks below depend on the resolved source.
      return;
    }

    const propertyNames = new Set<string>();

    object.properties.forEach((property, propertyIndex) => {
      const here = at('properties', propertyIndex);
      const label = `${object.apiName}.${property.name}`;

      register(property.id, [...here, 'id']);

      if (propertyNames.has(property.name) || unsafe.has(property.name))
        issues.report(
          'property.invalid-name',
          `Invalid property name '${property.name}' on object ${object.apiName}`,
          [...here, 'name'],
          object.id,
        );

      propertyNames.add(property.name);

      if (!manifest.fieldGroups.includes(property.access))
        issues.report(
          'property.unknown-field-group',
          `Unknown field group '${property.access}' on property ${label}`,
          [...here, 'access'],
          object.id,
        );

      if (
        property.origin.kind === 'native' ||
        property.origin.kind === 'native-reference'
      ) {
        if (resource)
          issues.report(
            'property.native-requires-native-membership',
            `Native business properties require native membership: property ${label} on source-backed object ${object.apiName}`,
            [...here, 'origin'],
            object.id,
          );

        if (
          property.origin.kind === 'native-reference' &&
          (property.schema.type !== 'string' ||
            property.schema.optional ||
            property.schema.nullable ||
            !objectById.has(property.origin.targetObjectDefinitionId))
        )
          issues.report(
            'reference.invalid-target',
            `Invalid native reference: property ${label} references unregistered or invalid object '${property.origin.targetObjectDefinitionId}'`,
            [...here, 'origin', 'targetObjectDefinitionId'],
            object.id,
          );
      } else if (property.origin.kind === 'object-id') {
        if (
          property.schema.type !== 'string' ||
          property.schema.nullable ||
          property.schema.optional ||
          property.access !== 'ordinary'
        )
          issues.report(
            'object.invalid-object-id',
            `objectId() must be an ordinary required string: property ${label}`,
            [...here, 'schema'],
            object.id,
          );
      } else if (property.origin.kind === 'reference') {
        const key = resource?.fields[property.origin.field];
        const targetId = property.origin.targetObjectDefinitionId;

        if (
          property.origin.sourceDefinitionId !== resource?.id ||
          !key ||
          key.type !== 'string' ||
          key.optional ||
          key.nullable ||
          property.schema.type !== 'string' ||
          property.schema.optional ||
          property.schema.nullable ||
          !objectById.has(targetId)
        )
          issues.report(
            'reference.invalid-target',
            `Invalid source reference target or key: property ${label} references object '${targetId}' through field '${property.origin.field}'`,
            [...here, 'origin'],
            object.id,
          );
      } else if (
        property.origin.sourceDefinitionId !== resource?.id ||
        !resource?.fields[property.origin.field] ||
        canonicalJson(resource.fields[property.origin.field]) !==
          canonicalJson(property.schema)
      ) {
        issues.report(
          'property.invalid-source-field',
          `Invalid source field reference: property ${label} reads field '${property.origin.field}' of source '${property.origin.sourceDefinitionId}'`,
          [...here, 'origin'],
          object.id,
        );
      }
    });

    const identities = object.properties.filter(
      (p) => p.origin.kind === 'object-id',
    ).length;

    if (identities !== 1)
      issues.report(
        'object.object-id-count',
        `Object '${object.id}' requires exactly one objectId() property; found ${identities}`,
        at('properties'),
        object.id,
      );
  });

  const traversalNames = new Set<string>();

  (manifest.relationships ?? []).forEach((relationship, index) => {
    const at = (...segments: Segment[]) => [
      'relationships',
      index,
      ...segments,
    ];

    register(relationship.id, at('id'));
    const from = objectById.get(relationship.fromObjectDefinitionId);
    const to = objectById.get(relationship.toObjectDefinitionId);
    const referenceTargets = (
      owner: typeof to,
      propertyId: string,
      target: typeof from,
    ) => {
      const property = owner?.properties.find((p) => p.id === propertyId);

      return Boolean(
        target &&
        property &&
        (property.origin.kind === 'reference' ||
          property.origin.kind === 'native-reference') &&
        property.origin.targetObjectDefinitionId === target.id,
      );
    };
    const valid =
      'through' in relationship
        ? relationship.through.fromReferencePropertyDefinitionId !==
            relationship.through.toReferencePropertyDefinitionId &&
          referenceTargets(
            objectById.get(relationship.through.objectDefinitionId),
            relationship.through.fromReferencePropertyDefinitionId,
            from,
          ) &&
          referenceTargets(
            objectById.get(relationship.through.objectDefinitionId),
            relationship.through.toReferencePropertyDefinitionId,
            to,
          )
        : referenceTargets(
            to,
            relationship.referencePropertyDefinitionId,
            from,
          );

    if (!from || !to || !valid) {
      issues.report(
        'relationship.invalid-endpoints',
        `Invalid relationship endpoints or reference: relationship '${relationship.id}' from '${relationship.fromObjectDefinitionId}' to '${relationship.toObjectDefinitionId}'`,
        at(),
        relationship.id,
      );

      return;
    }

    for (const [object, traversal, side] of [
      [from, relationship.forward, 'forward'],
      [to, relationship.reverse, 'reverse'],
    ] as const) {
      const key = JSON.stringify([object.id, traversal.name]);

      if (
        !traversal.name.trim() ||
        unsafe.has(traversal.name) ||
        traversalNames.has(key)
      )
        issues.report(
          'relationship.invalid-traversal',
          `Invalid or duplicate traversal name '${traversal.name}' on ${object.apiName} for relationship '${relationship.id}'`,
          at(side, 'name'),
          relationship.id,
        );

      traversalNames.add(key);
    }
  });

  for (const typeId of Object.keys(manifest.createPolicies ?? {})) {
    const object = objectById.get(typeId);

    if (object && object.sourceDefinitionId)
      issues.report(
        'policy.create-requires-native-membership',
        `Create policy requires native membership: ${object.apiName} is owned by source '${object.sourceDefinitionId}'`,
        ['createPolicies', typeId],
        typeId,
      );
  }

  const policies: readonly (readonly [
    string,
    Policy,
    readonly Segment[],
    string,
  ])[] = [
    ...Object.entries(manifest.policies).map(
      ([id, policy]) =>
        [id, policy, ['policies', id] as const, 'read'] as const,
    ),
    ...Object.entries(manifest.createPolicies ?? {}).map(
      ([id, read]) =>
        [
          id,
          { read, groups: {} } as Policy,
          ['createPolicies', id] as const,
          'create',
        ] as const,
    ),
  ];

  for (const [typeId, policy, base, kind] of policies) {
    const object = objectById.get(typeId);

    if (!object) {
      issues.report(
        'policy.unknown-object',
        `Unknown policy object '${typeId}'`,
        base,
        typeId,
      );

      continue;
    }

    const rule = kind === 'read' ? [...base, 'read'] : base;
    const label = `${object.apiName}.${kind}`;

    if (!manifest.roles.includes(policy.read.role))
      issues.report(
        'policy.unknown-role',
        `Unknown policy role '${policy.read.role}' in policy ${label}`,
        [...rule, 'role'],
        object.id,
      );

    for (const [group, gate] of Object.entries(policy.groups))
      if (!manifest.roles.includes(gate.role))
        issues.report(
          'policy.unknown-role',
          `Unknown policy role '${gate.role}' in policy ${object.apiName}.groups.${group}`,
          [...base, 'groups', group, 'role'],
          object.id,
        );

    if (policy.read.where) {
      const conditions =
        'all' in policy.read.where
          ? policy.read.where.all
          : [
              {
                path: [policy.read.where.propertyDefinitionId],
                claim: policy.read.where.claim,
              },
            ];

      conditions.forEach((condition, conditionIndex) => {
        const where = [...rule, 'where'];
        const here =
          'all' in policy.read.where!
            ? [...where, 'all', conditionIndex]
            : where;
        let current = object;

        for (const [index, id] of condition.path.entries()) {
          const property = current.properties.find((p) => p.id === id);

          if (!property) {
            issues.report(
              'policy.unknown-dependency',
              `Unknown policy dependency '${id}' on ${current.apiName} in policy ${label}`,
              [...here, 'path', index],
              object.id,
            );

            return;
          }

          if (index < condition.path.length - 1) {
            if (
              property.origin.kind !== 'reference' &&
              property.origin.kind !== 'native-reference'
            ) {
              issues.report(
                'policy.invalid-path',
                `Policy path must traverse a reference: ${current.apiName}.${property.name} in policy ${label}`,
                [...here, 'path', index],
                object.id,
              );

              return;
            }

            const target = objectById.get(
              property.origin.targetObjectDefinitionId,
            );

            // Reference targets were validated with their owning object.
            if (!target) return;

            current = target;
          } else {
            if (
              property.origin.kind === 'reference' ||
              property.origin.kind === 'native-reference'
            ) {
              issues.report(
                'policy.invalid-path',
                `Policy path must end at a scalar: ${current.apiName}.${property.name} in policy ${label}`,
                [...here, 'path', index],
                object.id,
              );

              return;
            }

            if (
              (condition.claim !== undefined) ===
              ('actor' in condition && condition.actor !== undefined)
            ) {
              issues.report(
                'policy.invalid-predicate',
                `Policy needs exactly one operand: condition on ${current.apiName}.${property.name} in policy ${label}`,
                here,
                object.id,
              );

              return;
            }

            const claim =
              condition.claim !== undefined
                ? manifest.claims[condition.claim]
                : { type: 'string', nullable: false, optional: false };

            if (!claim) {
              issues.report(
                'policy.unknown-claim',
                `Unknown policy claim '${condition.claim}' in policy ${label}`,
                [...here, 'claim'],
                object.id,
              );

              return;
            }

            if (
              claim.type !== property.schema.type ||
              (claim.nullable && !property.schema.nullable) ||
              (claim.optional && !property.schema.optional)
            )
              issues.report(
                'policy.incompatible-claim',
                `Incompatible policy claim '${condition.claim ?? 'actor.id'}' for ${current.apiName}.${property.name} in policy ${label}`,
                [...here, 'claim'],
                object.id,
              );
          }
        }
      });
    }

    for (const group of Object.keys(policy.groups))
      if (group === 'ordinary' || !manifest.fieldGroups.includes(group))
        issues.report(
          'policy.invalid-group',
          `Invalid policy group '${group}' in policy ${object.apiName}`,
          [...base, 'groups', group],
          object.id,
        );
  }

  const actionNames = new Set<string>();

  (manifest.actions ?? []).forEach((action, index) => {
    const at = (...segments: Segment[]) => ['actions', index, ...segments];

    register(action.id, at('id'));

    if (
      !action.apiName.trim() ||
      unsafe.has(action.apiName) ||
      actionNames.has(action.apiName)
    )
      issues.report(
        'action.invalid-api-name',
        `Invalid action API name '${action.apiName}' for action '${action.id}'`,
        at('apiName'),
        action.id,
      );

    actionNames.add(action.apiName);

    if (action.execute && !manifest.roles.includes(action.execute.role))
      issues.report(
        'policy.unknown-role',
        `Unknown action role '${action.execute.role}' on action ${action.apiName}`,
        at('execute', 'role'),
        action.id,
      );

    if (
      new Set(action.creates).size !== action.creates.length ||
      action.creates.some((id) => {
        const object = objectById.get(id);

        return !object || Boolean(object.sourceDefinitionId);
      })
    )
      issues.report(
        'action.invalid-capability',
        `Invalid native action capability: action ${action.apiName} creates ${JSON.stringify(action.creates)}`,
        at('creates'),
        action.id,
      );

    for (const code of Object.keys(action.errors ?? {}))
      if (!code.trim() || unsafe.has(code))
        issues.report(
          'action.invalid-field',
          'Invalid action error code',
          at('errors', code),
          action.id,
        );

    for (const [shapePath, shape] of [
      [['input'], action.input],
      [['output'], action.output],
      ...Object.entries(action.errors ?? {}).map(
        ([code, shape]) => [['errors', code], shape] as const,
      ),
    ] as const)
      for (const [name, field] of Object.entries(shape)) {
        if (!name.trim() || unsafe.has(name))
          issues.report(
            'action.invalid-field',
            `Invalid action field '${name}' in ${action.apiName}.${shapePath.join('.')}`,
            at(...shapePath, name),
            action.id,
          );

        if (
          field.references &&
          (field.type !== 'string' ||
            field.nullable ||
            field.optional ||
            !objectById.has(field.references))
        )
          issues.report(
            'action.invalid-reference',
            `Invalid action reference: ${action.apiName}.${shapePath.join('.')}.${name} references '${field.references}'`,
            at(...shapePath, name, 'references'),
            action.id,
          );
      }
  });

  if (issues.list.length) throw new ManifestValidationError(issues.list);

  return deepFreeze(manifest);
}
