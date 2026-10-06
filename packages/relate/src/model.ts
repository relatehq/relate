import { z } from 'zod';

const text = z.string().min(1);

export const scalarSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  optional: z.boolean(),
  nullable: z.boolean(),
});

export type ScalarSchema = z.infer<typeof scalarSchema>;

const roleGate = z.strictObject({ role: text });
const policySchema = z.strictObject({
  read: roleGate.extend({
    where: z
      .strictObject({ propertyDefinitionId: text, claim: text })
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
    z.strictObject({ kind: z.literal('object-id') }),
    z.strictObject({
      kind: z.literal('source'),
      sourceDefinitionId: text,
      field: text,
    }),
  ]),
});

export const manifestSchema = z.strictObject({
  formatVersion: z.literal(1),
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
      name: text,
      sourceDefinitionId: text,
      properties: z.array(propertySchema),
    }),
  ),
  policies: z.record(text, policySchema),
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
  return value === undefined
    ? schema.optional
    : value === null
      ? schema.nullable
      : typeof value === schema.type &&
        (schema.type !== 'number' || Number.isFinite(value));
}

const unsafe = new Set(['__proto__', 'prototype', 'constructor']);

export function validateManifest(input: unknown): Manifest {
  const manifest = manifestSchema.parse(input);
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

    if (names.has(object.name)) throw new Error('Duplicate object name');

    names.add(object.name);
    const resource = manifest.sources.find(
      (s) => s.id === object.sourceDefinitionId,
    );

    if (!resource) throw new Error('Unknown membership source');

    const propertyNames = new Set<string>();

    for (const property of object.properties) {
      register(property.id);

      if (propertyNames.has(property.name) || unsafe.has(property.name))
        throw new Error('Invalid property name');

      propertyNames.add(property.name);

      if (!manifest.fieldGroups.includes(property.access))
        throw new Error('Unknown field group');

      if (property.origin.kind === 'native') {
        throw new Error(
          'Native business properties are not supported in this slice',
        );
      } else if (property.origin.kind === 'object-id') {
        if (
          property.schema.type !== 'string' ||
          property.schema.nullable ||
          property.schema.optional ||
          property.access !== 'ordinary'
        )
          throw new Error('objectId() must be an ordinary required string');
      } else if (
        property.origin.sourceDefinitionId !== resource.id ||
        !resource.fields[property.origin.field] ||
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

  for (const [typeId, policy] of Object.entries(manifest.policies)) {
    const object = manifest.objects.find((o) => o.id === typeId);

    if (!object) throw new Error('Unknown policy object');

    if (
      policy.read.where &&
      !object.properties.some(
        (p) => p.id === policy.read.where!.propertyDefinitionId,
      )
    )
      throw new Error('Unknown policy dependency');

    if (
      ![
        policy.read.role,
        ...Object.values(policy.groups).map((gate) => gate.role),
      ].every((role) => manifest.roles.includes(role))
    )
      throw new Error('Unknown policy role');

    if (policy.read.where) {
      const claim = manifest.claims[policy.read.where.claim];
      const property = object.properties.find(
        (p) => p.id === policy.read.where!.propertyDefinitionId,
      )!;

      if (!claim) throw new Error('Unknown policy claim');

      if (
        claim.type !== property.schema.type ||
        (claim.nullable && !property.schema.nullable) ||
        (claim.optional && !property.schema.optional)
      )
        throw new Error('Incompatible policy claim');
    }

    if (
      Object.keys(policy.groups).some(
        (g) => g === 'ordinary' || !manifest.fieldGroups.includes(g),
      )
    )
      throw new Error('Invalid policy group');
  }

  return deepFreeze(manifest);
}
