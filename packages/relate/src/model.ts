import { z } from 'zod';

const id = z.string().min(1);

export const scalarSchema = z.strictObject({
  type: z.enum(['string', 'number', 'boolean']),
  optional: z.boolean(),
  nullable: z.boolean(),
});

export type ScalarSchema = z.infer<typeof scalarSchema>;

const roleGate = z.strictObject({ role: id });
const policySchema = z.strictObject({
  read: roleGate.extend({
    where: z.strictObject({ propertyDefinitionId: id, claim: id }).optional(),
    evidenceMaxAgeMs: z.number().finite().nonnegative(),
  }),
  groups: z.record(id, roleGate),
});

export type Policy = z.infer<typeof policySchema>;

const propertySchema = z.strictObject({
  definitionId: id,
  name: id,
  access: id,
  schema: scalarSchema,
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('native') }),
    z.strictObject({ kind: z.literal('object-id') }),
    z.strictObject({
      kind: z.literal('source'),
      sourceDefinitionId: id,
      field: id,
    }),
  ]),
});

export const manifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  graphDefinitionId: id,
  fieldGroups: z.array(id),
  sources: z.array(
    z.strictObject({
      definitionId: id,
      idField: id,
      fields: z.record(id, scalarSchema),
    }),
  ),
  objects: z.array(
    z.strictObject({
      definitionId: id,
      name: id,
      sourceDefinitionId: id,
      properties: z.array(propertySchema),
    }),
  ),
  policies: z.record(id, policySchema),
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

  for (const resource of manifest.sources) {
    register(resource.definitionId);
    const key = resource.fields[resource.idField];

    if (!key || key.type !== 'string' || key.optional || key.nullable)
      throw new Error('Source idField must be a required string');

    if (Object.keys(resource.fields).some((k) => unsafe.has(k)))
      throw new Error('Unsafe source field');
  }

  const names = new Set<string>();

  for (const object of manifest.objects) {
    register(object.definitionId);

    if (names.has(object.name)) throw new Error('Duplicate object name');

    names.add(object.name);
    const resource = manifest.sources.find(
      (s) => s.definitionId === object.sourceDefinitionId,
    );

    if (!resource) throw new Error('Unknown membership source');

    const propertyNames = new Set<string>();

    for (const property of object.properties) {
      register(property.definitionId);

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
        property.origin.sourceDefinitionId !== resource.definitionId ||
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
    const object = manifest.objects.find((o) => o.definitionId === typeId);

    if (!object) throw new Error('Unknown policy object');

    if (
      policy.read.where &&
      !object.properties.some(
        (p) => p.definitionId === policy.read.where!.propertyDefinitionId,
      )
    )
      throw new Error('Unknown policy dependency');

    if (
      Object.keys(policy.groups).some(
        (g) => g === 'ordinary' || !manifest.fieldGroups.includes(g),
      )
    )
      throw new Error('Invalid policy group');
  }

  return deepFreeze(manifest);
}
