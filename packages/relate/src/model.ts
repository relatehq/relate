import { z } from 'zod';

const text = z.string().min(1);

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
});

export type ScalarSchema = z.infer<typeof scalarSchema>;

export const actionFieldSchema = scalarSchema.extend({
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
  formatVersion: z.literal(4),
  graphDefinitionId: text,
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
      description: z.string().optional(),
      sourceDefinitionId: text.optional(),
      properties: z.array(propertySchema),
    }),
  ),
  relationships: z
    .array(
      z.strictObject({
        id: text,
        fromObjectDefinitionId: text,
        toObjectDefinitionId: text,
        referencePropertyDefinitionId: text,
        forward: z.strictObject({ name: text, cardinality: z.literal('many') }),
        reverse: z.strictObject({ name: text, cardinality: z.literal('one') }),
      }),
    )
    .optional(),
  policies: z.record(text, policySchema),
  createPolicies: z.record(text, policySchema.shape.read).optional(),
  actions: z
    .array(
      z.strictObject({
        id: text,
        apiName: text,
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

export function validateManifest(input: unknown): Manifest {
  const manifest = manifestSchema.parse(input);
  // Validate type-specific constraint metadata on every schema, including loaded JSON.
  const scalars = [
    ...Object.values(manifest.claims),
    ...manifest.sources.flatMap((s) => Object.values(s.fields)),
    ...manifest.objects.flatMap((o) => o.properties.map((p) => p.schema)),
    ...(manifest.actions ?? []).flatMap((a) =>
      [a.input, a.output, ...Object.values(a.errors ?? {})].flatMap((s) =>
        Object.values(s),
      ),
    ),
  ];

  for (const schema of scalars) {
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
      throw new Error('Constraint does not match scalar type');

    if (
      schema.type === 'string' &&
      (schema.minLength ?? 0) > (schema.maxLength ?? Infinity)
    )
      throw new Error('Unsatisfiable string bounds');

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
        throw new Error('Unsatisfiable number bounds');
    }
  }

  const seen = new Set<string>();
  const register = (value: string) => {
    if (!value.trim() || seen.has(value) || unsafe.has(value))
      throw new Error(`Invalid or duplicate definition ID: ${value}`);

    seen.add(value);
  };

  register(manifest.graphDefinitionId);

  if (
    !manifest.fieldGroups.includes('ordinary') ||
    new Set(manifest.fieldGroups).size !== manifest.fieldGroups.length ||
    manifest.fieldGroups.some((g) => unsafe.has(g))
  )
    throw new Error('Invalid field groups');

  if (
    new Set(manifest.roles).size !== manifest.roles.length ||
    manifest.roles.some((role) => !role.trim() || unsafe.has(role))
  )
    throw new Error('Invalid roles');

  if (
    Object.keys(manifest.claims).some(
      (name) => !name.trim() || unsafe.has(name),
    )
  )
    throw new Error('Invalid claims');

  for (const resource of manifest.sources) {
    register(resource.id);
    const key = resource.fields[resource.idField];

    if (!key || key.type !== 'string' || key.optional || key.nullable)
      throw new Error('Source idField must be a required string');

    if (Object.keys(resource.fields).some((k) => unsafe.has(k)))
      throw new Error('Unsafe source field');
  }

  const names = new Set<string>();

  for (const object of manifest.objects) {
    register(object.id);

    if (
      !object.apiName.trim() ||
      unsafe.has(object.apiName) ||
      names.has(object.apiName)
    )
      throw new Error('Invalid or duplicate object API name');

    names.add(object.apiName);
    const resource = manifest.sources.find(
      (s) => s.id === object.sourceDefinitionId,
    );

    if (object.sourceDefinitionId && !resource)
      throw new Error('Unknown membership source');

    const propertyNames = new Set<string>();

    for (const property of object.properties) {
      register(property.id);

      if (propertyNames.has(property.name) || unsafe.has(property.name))
        throw new Error('Invalid property name');

      propertyNames.add(property.name);

      if (!manifest.fieldGroups.includes(property.access))
        throw new Error('Unknown field group');

      if (
        property.origin.kind === 'native' ||
        property.origin.kind === 'native-reference'
      ) {
        if (resource)
          throw new Error(
            'Native business properties require native membership',
          );

        if (
          property.origin.kind === 'native-reference' &&
          (property.schema.type !== 'string' ||
            property.schema.optional ||
            property.schema.nullable ||
            !manifest.objects.some(
              (o) =>
                o.id ===
                (property.origin as { targetObjectDefinitionId: string })
                  .targetObjectDefinitionId,
            ))
        )
          throw new Error('Invalid native reference');
      } else if (property.origin.kind === 'object-id') {
        if (
          property.schema.type !== 'string' ||
          property.schema.nullable ||
          property.schema.optional ||
          property.access !== 'ordinary'
        )
          throw new Error('objectId() must be an ordinary required string');
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
          !manifest.objects.some((o) => o.id === targetId)
        )
          throw new Error('Invalid source reference target or key');
      } else if (
        property.origin.sourceDefinitionId !== resource?.id ||
        !resource?.fields[property.origin.field] ||
        canonicalJson(resource.fields[property.origin.field]) !==
          canonicalJson(property.schema)
      ) {
        throw new Error('Invalid source field reference');
      }
    }

    if (
      object.properties.filter((p) => p.origin.kind === 'object-id').length !==
      1
    )
      throw new Error('Each object must have exactly one objectId() property');
  }

  const traversalNames = new Set<string>();

  for (const relationship of manifest.relationships ?? []) {
    register(relationship.id);
    const from = manifest.objects.find(
      (o) => o.id === relationship.fromObjectDefinitionId,
    );
    const to = manifest.objects.find(
      (o) => o.id === relationship.toObjectDefinitionId,
    );
    const via = to?.properties.find(
      (p) => p.id === relationship.referencePropertyDefinitionId,
    );

    if (
      !from ||
      !to ||
      !via ||
      (via.origin.kind !== 'reference' &&
        via.origin.kind !== 'native-reference') ||
      via.origin.targetObjectDefinitionId !== from.id
    )
      throw new Error('Invalid relationship endpoints or reference');

    for (const [object, traversal] of [
      [from, relationship.forward],
      [to, relationship.reverse],
    ] as const) {
      const key = JSON.stringify([object.id, traversal.name]);

      if (
        !traversal.name.trim() ||
        unsafe.has(traversal.name) ||
        traversalNames.has(key)
      )
        throw new Error('Invalid or duplicate traversal name');

      traversalNames.add(key);
    }
  }

  for (const [typeId, rule] of Object.entries(manifest.createPolicies ?? {})) {
    if (!manifest.objects.some((o) => o.id === typeId && !o.sourceDefinitionId))
      throw new Error('Create policy requires native membership');
  }

  for (const [typeId, policy] of [
    ...Object.entries(manifest.policies),
    ...Object.entries(manifest.createPolicies ?? {}).map(
      ([id, read]) => [id, { read, groups: {} } as Policy] as const,
    ),
  ]) {
    const object = manifest.objects.find((o) => o.id === typeId);

    if (!object) throw new Error('Unknown policy object');

    if (
      ![
        policy.read.role,
        ...Object.values(policy.groups).map((gate) => gate.role),
      ].every((role) => manifest.roles.includes(role))
    )
      throw new Error('Unknown policy role');

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

      for (const condition of conditions) {
        let current = object;

        for (const [index, id] of condition.path.entries()) {
          const property = current.properties.find((p) => p.id === id);

          if (!property) throw new Error('Unknown policy dependency');

          if (index < condition.path.length - 1) {
            if (
              property.origin.kind !== 'reference' &&
              property.origin.kind !== 'native-reference'
            )
              throw new Error('Policy path must traverse a reference');

            const targetId = property.origin.targetObjectDefinitionId;

            current = manifest.objects.find((o) => o.id === targetId)!;
          } else {
            if (
              property.origin.kind === 'reference' ||
              property.origin.kind === 'native-reference'
            )
              throw new Error('Policy path must end at a scalar');

            if (
              (condition.claim !== undefined) ===
              ('actor' in condition && condition.actor !== undefined)
            )
              throw new Error('Policy needs exactly one operand');

            const claim =
              condition.claim !== undefined
                ? manifest.claims[condition.claim]
                : { type: 'string', nullable: false, optional: false };

            if (!claim) throw new Error('Unknown policy claim');

            if (
              claim.type !== property.schema.type ||
              (claim.nullable && !property.schema.nullable) ||
              (claim.optional && !property.schema.optional)
            )
              throw new Error('Incompatible policy claim');
          }
        }
      }
    }

    if (
      Object.keys(policy.groups).some(
        (g) => g === 'ordinary' || !manifest.fieldGroups.includes(g),
      )
    )
      throw new Error('Invalid policy group');
  }

  const actionNames = new Set<string>();

  for (const action of manifest.actions ?? []) {
    register(action.id);

    if (
      !action.apiName.trim() ||
      unsafe.has(action.apiName) ||
      actionNames.has(action.apiName)
    )
      throw new Error('Invalid action API name');

    actionNames.add(action.apiName);

    if (action.execute && !manifest.roles.includes(action.execute.role))
      throw new Error('Unknown action role');

    if (
      new Set(action.creates).size !== action.creates.length ||
      action.creates.some(
        (id) =>
          !manifest.objects.some((o) => o.id === id && !o.sourceDefinitionId),
      )
    )
      throw new Error('Invalid native action capability');

    if (
      Object.keys(action.errors ?? {}).some(
        (code) => !code.trim() || unsafe.has(code),
      )
    )
      throw new Error('Invalid action error code');

    for (const shape of [
      action.input,
      action.output,
      ...Object.values(action.errors ?? {}),
    ])
      for (const [name, field] of Object.entries(shape)) {
        if (!name.trim() || unsafe.has(name))
          throw new Error('Invalid action field');

        if (
          field.references &&
          (field.type !== 'string' ||
            field.nullable ||
            field.optional ||
            !manifest.objects.some((o) => o.id === field.references))
        )
          throw new Error('Invalid action reference');
      }
  }

  return deepFreeze(manifest);
}
