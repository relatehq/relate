import { expect, it } from 'vitest';
import { z } from 'zod';
import { validateManifest } from 'relate/model';
import { compile } from 'relate/compiler';
import {
  defineObject,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';
import {
  access,
  Customer,
  customerGraph,
} from '../../../examples/postgres-persistence/src/model.js';

it('compiles named object registries without changing stable persisted identity', () => {
  const original = compile(customerGraph);

  expect(compile({ ...customerGraph, objects: { Customer } })).toEqual(
    original,
  );
  const renamed = compile({
    ...customerGraph,
    objects: { Accounts: Customer },
    policies: { Accounts: customerGraph.policies.Customer },
  });

  expect(renamed.manifest.objects[0]).toEqual({
    ...original.manifest.objects[0],
    apiName: 'Accounts',
  });
  expect(renamed.manifest.policies).toEqual(original.manifest.policies);
  expect(renamed.definitionRevision).not.toBe(original.definitionRevision);
  expect(() =>
    compile({ ...customerGraph, objects: { Customer, Duplicate: Customer } }),
  ).toThrow();
});

it('produces deterministic frozen portable contracts and preserves definition IDs across renames', () => {
  const model = compile(customerGraph);

  expect(
    compile({
      ...customerGraph,
      access: {
        ...access,
        fieldGroups: [...access.fieldGroups].reverse(),
        roles: [...access.roles].reverse(),
      },
    }),
  ).toEqual(model);
  expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  expect(Object.isFrozen(model.manifest.objects[0]!.properties)).toBe(true);
  const { name, ...rest } = Customer.properties;
  const renamed = compile({
    ...customerGraph,
    objects: {
      Customer: { ...Customer, properties: { ...rest, displayName: name } },
    },
  });

  expect(
    renamed.manifest.objects[0]!.properties.find((p) => p.id === name.id)?.name,
  ).toBe('displayName');
  expect(renamed.definitionRevision).not.toBe(model.definitionRevision);
});

it('rejects missing, empty and duplicate IDs, unknown classifications and broken references', () => {
  expect(() => compile({ ...customerGraph, id: '' })).toThrow();
  expect(() =>
    compile({ ...customerGraph, objects: { Customer, Duplicate: Customer } }),
  ).toThrow();

  for (const access of [
    null,
    'unknown',
    { kind: 'field-group' },
    { kind: 'field-group', name: 'unknown' },
  ]) {
    expect(() =>
      compile({
        ...customerGraph,
        objects: {
          Customer: {
            ...Customer,
            properties: {
              ...Customer.properties,
              name: { ...Customer.properties.name, access },
            },
          },
        },
      } as never),
    ).toThrow();
  }

  expect(() =>
    compile({
      ...customerGraph,
      objects: {
        Customer: {
          ...Customer,
          properties: {
            ...Customer.properties,
            name: {
              ...Customer.properties.name,
              id: Customer.id,
            },
          },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    compile({
      ...customerGraph,
      policies: {
        Customer: {
          ...customerGraph.policies.Customer!,
          read: {
            gate: access.role('employee'),
            where: {
              missing: { eq: access.claims.portfolio },
            },
            evidenceMaxAgeMs: 100,
          },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    compile({
      ...customerGraph,
      objects: {
        Customer: {
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
      },
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
  z.coerce.string(),
  z.coerce.string().optional(),
  z.coerce.number(),
  z.coerce.boolean().nullable(),
  z.object({ name: z.string() }),
])('rejects unsupported schemas instead of dropping validation', (schema) => {
  expect(() =>
    compile({
      ...customerGraph,
      objects: {
        Customer: {
          ...Customer,
          properties: {
            ...Customer.properties,
            name: { ...Customer.properties.name, schema },
          },
        },
      },
    }),
  ).toThrow(/Unsupported schema/);
});

it('supports explicit optional and nullable scalar values', () => {
  const resource = defineSource({
    id: 'test.source',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      note: z.string().nullable().optional(),
    }),
  });
  const object = defineObject({
    id: 'test.object',
    label: 'Test',
    membership: source(resource),
    properties: {
      id: objectId({
        id: 'test.key',
        access: access.groups.ordinary,
      }),
      note: from(resource.fields.note, {
        id: 'test.note',
        access: access.groups.ordinary,
      }),
    },
  });
  const result = compile({
    id: 'test.graph',
    objects: { object },
    access,
    policies: { object: { read: 'deny' } },
  });

  expect(
    result.manifest.objects[0]!.properties.find((p) => p.name === 'note')
      ?.schema,
  ).toEqual({ type: 'string', optional: true, nullable: true });
});

it('requires exactly one explicit objectId during authoring, compilation and manifest validation', () => {
  const { id, ...withoutId } = Customer.properties;
  const extra = objectId({
    id: 'customer.second-id',
    access: access.groups.ordinary,
  });

  for (const properties of [withoutId, { ...Customer.properties, extra }]) {
    const object = { ...Customer, properties };

    expect(() => defineObject(object)).toThrow(/exactly one objectId/);
    expect(() =>
      compile({ ...customerGraph, objects: { Customer: object } }),
    ).toThrow(/exactly one objectId/);
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
        id: 'customer.second-id',
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
    { ...Customer.properties.id, access: access.groups.financial },
    { ...Customer.properties.id, origin: { kind: 'native' as const } },
  ]) {
    expect(() =>
      compile({
        ...customerGraph,
        objects: {
          Customer: {
            ...Customer,
            properties: { ...Customer.properties, id: replacement },
          },
        },
      }),
    ).toThrow();
  }
});

it('defaults omitted property access to ordinary without changing the compiled contract', () => {
  const resource = Customer.membership.resource;
  const properties = {
    ...Customer.properties,
    id: objectId({ id: 'customer.id' }),
    name: from(
      {
        sourceDefinitionId: resource.id,
        field: 'display_name',
        schema: z.string(),
      },
      { id: 'customer.name' },
    ),
    customer: reference(Customer, {
      id: 'customer.reference',
      from: {
        sourceDefinitionId: resource.id,
        field: resource.idField,
        schema: z.string(),
      },
    }),
    revenue: Customer.properties.revenue,
  };
  const graph = {
    ...customerGraph,
    objects: { Customer: { ...Customer, properties } },
  };
  const model = compile(graph);
  const explicit = compile({
    ...graph,
    objects: {
      Customer: {
        ...Customer,
        properties: Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [
            name,
            {
              ...property,
              access: property.access ?? access.groups.ordinary,
            },
          ]),
        ),
      },
    },
  });

  expect(model).toEqual(explicit);
  expect(
    Object.fromEntries(
      model.manifest.objects[0]!.properties.map((p) => [p.name, p.access]),
    ),
  ).toEqual({
    id: 'ordinary',
    name: 'ordinary',
    portfolio: 'ordinary',
    customer: 'ordinary',
    revenue: 'financial',
  });
  expect(() =>
    compile({ ...graph, access: { ...access, fieldGroups: ['financial'] } }),
  ).toThrow();
});
