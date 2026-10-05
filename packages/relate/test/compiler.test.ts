import { expect, it } from 'vitest';
import { z } from 'zod';
import { validateManifest } from 'relate/model';
import { compile } from 'relate/compiler';
import { defineObject, defineSource, from, objectId, source } from 'relate';
import {
  Customer,
  customerGraph,
} from '../../../examples/postgres-persistence/src/model.js';

it('produces deterministic frozen portable contracts and preserves definition IDs across renames', () => {
  const model = compile(customerGraph);

  expect(
    compile({
      ...customerGraph,
      fieldGroups: [...customerGraph.fieldGroups].reverse(),
    }),
  ).toEqual(model);
  expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  expect(Object.isFrozen(model.manifest.objects[0]!.properties)).toBe(true);
  const { name, ...rest } = Customer.properties;
  const renamed = compile({
    ...customerGraph,
    objects: [{ ...Customer, properties: { ...rest, displayName: name } }],
  });

  expect(
    renamed.manifest.objects[0]!.properties.find(
      (p) => p.definitionId === name.definitionId,
    )?.name,
  ).toBe('displayName');
  expect(renamed.definitionRevision).not.toBe(model.definitionRevision);
});

it('rejects missing, empty and duplicate IDs, unknown classifications and broken references', () => {
  expect(() => compile({ ...customerGraph, definitionId: '' })).toThrow();
  expect(() =>
    compile({ ...customerGraph, objects: [Customer, Customer] }),
  ).toThrow();

  for (const access of [undefined, 'unknown']) {
    expect(() =>
      compile({
        ...customerGraph,
        objects: [
          {
            ...Customer,
            properties: {
              ...Customer.properties,
              name: { ...Customer.properties.name, access },
            },
          },
        ],
      } as never),
    ).toThrow();
  }

  expect(() =>
    compile({
      ...customerGraph,
      objects: [
        {
          ...Customer,
          properties: {
            ...Customer.properties,
            name: {
              ...Customer.properties.name,
              definitionId: Customer.definitionId,
            },
          },
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    compile({
      ...customerGraph,
      policies: {
        [Customer.definitionId]: {
          ...customerGraph.policies[Customer.definitionId]!,
          read: {
            role: 'employee',
            where: { propertyDefinitionId: 'missing', claim: 'organization' },
            evidenceMaxAgeMs: 100,
          },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    compile({
      ...customerGraph,
      objects: [
        {
          ...Customer,
          properties: {
            ...Customer.properties,
            name: {
              ...Customer.properties.name,
              origin: {
                kind: 'source',
                sourceDefinitionId: 'wrong',
                field: 'name',
              },
            },
          },
        },
      ],
    }),
  ).toThrow();
});

it.each([
  z
    .string()
    .optional()
    .refine((v) => v !== 'bad'),
  z.string().min(2),
  z.string().refine((v) => v !== 'bad'),
  z.string().transform((v) => v.toUpperCase()),
  z.string().default('fallback'),
  z.object({ name: z.string() }),
])('rejects unsupported schemas instead of dropping validation', (schema) => {
  expect(() =>
    compile({
      ...customerGraph,
      objects: [
        {
          ...Customer,
          properties: {
            ...Customer.properties,
            name: { ...Customer.properties.name, schema },
          },
        },
      ],
    }),
  ).toThrow(/Unsupported schema/);
});

it('supports explicit optional and nullable scalar values', () => {
  const resource = defineSource({
    definitionId: 'test.source',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      note: z.string().nullable().optional(),
    }),
  });
  const object = defineObject({
    definitionId: 'test.object',
    name: 'Test',
    membership: source(resource),
    properties: {
      id: objectId({ definitionId: 'test.key', access: 'ordinary' }),
      note: from(resource.fields.note, {
        definitionId: 'test.note',
        access: 'ordinary',
      }),
    },
  });
  const result = compile({
    definitionId: 'test.graph',
    objects: [object],
    fieldGroups: ['ordinary'],
    policies: {},
  });

  expect(
    result.manifest.objects[0]!.properties.find((p) => p.name === 'note')
      ?.schema,
  ).toEqual({ type: 'string', optional: true, nullable: true });
});

it('requires exactly one explicit objectId during authoring, compilation and manifest validation', () => {
  const { id, ...withoutId } = Customer.properties;
  const extra = objectId({
    definitionId: 'customer.second-id',
    access: 'ordinary',
  });

  for (const properties of [withoutId, { ...Customer.properties, extra }]) {
    const object = { ...Customer, properties };

    expect(() => defineObject(object)).toThrow(/exactly one objectId/);
    expect(() => compile({ ...customerGraph, objects: [object] })).toThrow(
      /exactly one objectId/,
    );
  }

  for (const count of [0, 2]) {
    const manifest = structuredClone(compile(customerGraph).manifest);
    const object = manifest.objects[0]!;
    const identity = object.properties.find(
      (p) => p.origin.kind === 'object-id',
    )!;

    object.properties = object.properties.filter((p) => p !== identity);

    if (count === 2)
      object.properties.push(identity, {
        ...identity,
        name: 'extra',
        definitionId: 'customer.second-id',
      });

    expect(() => validateManifest(manifest)).toThrow(/exactly one objectId/);
  }

  expect(id.schema.parse('generated-id')).toBe('generated-id');
});

it('rejects invalid object ID schemas, classifications and native substitutes', () => {
  for (const replacement of [
    { ...Customer.properties.id, schema: z.number() },
    { ...Customer.properties.id, schema: z.string().optional() },
    { ...Customer.properties.id, schema: z.string().nullable() },
    { ...Customer.properties.id, access: 'financial' },
    { ...Customer.properties.id, origin: { kind: 'native' as const } },
  ]) {
    expect(() =>
      compile({
        ...customerGraph,
        objects: [
          {
            ...Customer,
            properties: { ...Customer.properties, id: replacement },
          },
        ],
      }),
    ).toThrow();
  }
});
