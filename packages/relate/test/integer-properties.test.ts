import { expect, it } from 'vitest';
import { z } from 'zod';
import { compile } from 'relate/compiler';
import {
  defineAccess,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import { accepts, validateManifest } from 'relate/model';

function model(schema: z.ZodType) {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const Counter = defineObject({
    id: 'counter',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'counter.id' }),
      value: native(schema, { id: 'counter.value' }),
    },
  });

  return compile(
    defineGraph({
      id: 'integers',
      access,
      objects: { Counter },
      policies: {
        Counter: { read: { gate: access.role('reader') } },
      },
    }),
  );
}

it.each([
  {
    schema: z.int32(),
    type: 'number',
    format: 'int32',
    valid: [-2147483648, 0, 2147483647],
    invalid: [-2147483649, 2147483648, 1.5, '1', 1n, Infinity],
  },
  {
    schema: z.int64(),
    type: 'string',
    format: 'int64',
    valid: [
      '-9223372036854775808',
      '0',
      '9007199254740993',
      '9223372036854775807',
    ],
    invalid: [
      '-9223372036854775809',
      '9223372036854775808',
      '01',
      '-0',
      '+1',
      '1.0',
      '1e2',
      ' 1',
      '1\n',
      '1\r',
      1,
      1n,
    ],
  },
])(
  'preserves $format across manifest JSON and validates its exact representation',
  ({ schema, type, format, valid, invalid }) => {
    const compiled = model(schema.optional().nullable());
    const manifest = validateManifest(
      JSON.parse(JSON.stringify(compiled.manifest)),
    );
    const scalar = manifest.objects[0]!.properties.find(
      (property) => property.name === 'value',
    )!.schema;

    expect(scalar).toEqual({ type, format, optional: true, nullable: true });

    for (const value of [...valid, null, undefined])
      expect(accepts(scalar, value)).toBe(true);

    for (const value of invalid) expect(accepts(scalar, value)).toBe(false);
  },
);

it.each([
  z.bigint(),
  z.int(),
  z.int32().min(0),
  z.int64().min(0n),
  z.coerce.bigint(),
])(
  'rejects integer schemas whose additional semantics cannot cross JSON',
  (schema) => {
    expect(() => model(schema)).toThrow();
  },
);

it.each([
  { type: 'string', format: 'int32' },
  { type: 'number', format: 'int64' },
  { type: 'number', format: 'int32', minimum: 1 },
  { type: 'string', format: 'int64', minLength: 2 },
  { type: 'string', format: 'int64', precision: 'second' },
])('rejects forged integer metadata: %j', (replacement) => {
  const manifest = structuredClone(model(z.int64()).manifest);
  const property = manifest.objects[0]!.properties.find(
    (property) => property.name === 'value',
  )!;

  Object.assign(property.schema, replacement);
  expect(() => validateManifest(manifest)).toThrow();
});

it('uses the same decimal string encoding for development principal claims', () => {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: { account: z.int64() },
  });
  const graph = defineGraph({
    id: 'claims',
    access,
    objects: {},
    policies: {},
    principals: {
      reader: { roles: ['reader'], claims: { account: '9007199254740993' } },
    },
  });

  expect(compile(graph).principals.reader?.claims.account).toBe(
    '9007199254740993',
  );
});

it('does not treat int64 string encodings as object IDs, references or source keys', () => {
  const compiled = model(z.int64());

  for (const kind of ['object-id', 'native-reference'] as const) {
    const manifest = structuredClone(compiled.manifest);
    const property = manifest.objects[0]!.properties.find(
      (property) => property.name === 'value',
    )!;

    Object.assign(property, {
      origin:
        kind === 'object-id'
          ? { kind }
          : { kind, targetObjectDefinitionId: 'counter' },
    });
    expect(() => validateManifest(manifest)).toThrow();
  }

  const manifest = structuredClone(compiled.manifest);

  Object.assign(manifest, {
    sources: [
      {
        id: 'source',
        idField: 'id',
        fields: {
          id: {
            type: 'string',
            format: 'int64',
            optional: false,
            nullable: false,
          },
        },
      },
    ],
  });
  expect(() => validateManifest(manifest)).toThrow();
});

it.each(['int32', 'int64'] as const)(
  'requires matching logical formats in %s policy claims',
  (format) => {
    const manifest = structuredClone(
      model(format === 'int64' ? z.int64() : z.int32()).manifest,
    );

    Object.assign(manifest, {
      claims: {
        account: {
          type: format === 'int64' ? 'string' : 'number',
          optional: false,
          nullable: false,
        },
      },
    });
    Object.assign(manifest.policies.counter!.read, {
      where: { propertyDefinitionId: 'counter.value', claim: 'account' },
      evidenceMaxAgeMs: 60000,
    });
    expect(() => validateManifest(manifest)).toThrow();
    Object.assign(manifest.claims.account!, { format });
    expect(() => validateManifest(manifest)).not.toThrow();
  },
);
