import { expect, it } from 'vitest';
import { z } from 'zod';
import { compile } from 'relate/compiler';
import { accepts, validateManifest } from 'relate/model';
import {
  graph,
  AddAccountReview,
  AccountReview,
} from '../../../tests/support/native-action-model.js';

it('exports the same note limits on action input and native property for discovery', () => {
  const model = JSON.parse(JSON.stringify(compile(graph)));
  const manifest = validateManifest(model.manifest);
  const input = manifest.actions![0]!.input.note;
  const property = manifest.objects
    .find((o) => o.id === AccountReview.id)!
    .properties.find((p) => p.name === 'note')!;
  const { description, ...inputSchema } = input!;

  expect(description).toBe('Assessment and recommended next steps.');
  expect(inputSchema).toEqual({
    type: 'string',
    optional: false,
    nullable: false,
    minLength: 1,
    maxLength: 4000,
  });
  expect(property.schema).toEqual(inputSchema);
});

it.each([
  {
    schema: z.iso
      .datetime({ offset: true, precision: 3 })
      .optional()
      .nullable(),
    bounds: { format: 'timestamp' },
    values: [
      undefined,
      null,
      '2024-02-29T00:00:00.000Z',
      '2026-10-01T01:00:00.000+01:00',
      '2026-02-29T00:00:00.000Z',
      '2026-10-01',
      '2026-10-01T00:00:00.000',
      '2026-10-01T00:00:00Z',
      '2026-10-01T00:00:00.0001Z',
      0,
    ],
  },
  {
    schema: z.string().min(2).max(4),
    bounds: { minLength: 2, maxLength: 4 },
    values: [
      '',
      'a',
      'ab',
      'abcd',
      'abcde',
      '😀',
      '😀😀',
      '😀😀😀😀',
      '😀😀😀😀😀',
    ],
  },
  {
    schema: z.string().length(2).optional().nullable(),
    bounds: { minLength: 2, maxLength: 2 },
    values: [undefined, null, 'a', 'ab', 'abc', '😀😀'],
  },
  {
    schema: z.string().min(3).min(1).max(8).max(4),
    bounds: { minLength: 3, maxLength: 4 },
    values: ['ab', 'abc', 'abcd', 'abcde'],
  },
  {
    schema: z.number().min(0).max(100),
    bounds: { minimum: 0, maximum: 100 },
    values: [-1, 0, 0.5, 100, 101, NaN, Infinity, '1'],
  },
  {
    schema: z.number().gt(0).lt(1).optional().nullable(),
    bounds: { exclusiveMinimum: 0, exclusiveMaximum: 1 },
    values: [undefined, null, 0, 0.5, 1, -Infinity],
  },
  {
    schema: z.number().min(3).min(1).max(8).max(5).gt(3).lt(5),
    bounds: {
      minimum: 3,
      maximum: 5,
      exclusiveMinimum: 3,
      exclusiveMaximum: 5,
    },
    values: [1, 3, 4, 5, 6, 8],
  },
])(
  'preserves portable bounds and matches Zod acceptance (%#. case)',
  ({ schema, bounds, values }) => {
    const compiled = compile({
      ...graph,
      actions: {
        addAccountReview: {
          ...AddAccountReview,
          input: z.object({ value: schema }),
        },
      },
    });
    const manifest = validateManifest(
      JSON.parse(JSON.stringify(compiled.manifest)),
    );
    const field = manifest.actions![0]!.input.value!;

    expect(field).toMatchObject(bounds);

    for (const value of values)
      expect(accepts(field, value), String(value)).toBe(
        schema.safeParse(value).success,
      );
  },
);

it.each([
  // @ts-expect-error JavaScript callers can supply runtime-supported conditional checks
  z.string().min(1, { when: () => false }),
  // @ts-expect-error JavaScript callers can supply runtime-supported conditional checks
  z.string().max(2, { when: () => false }),
  // @ts-expect-error JavaScript callers can supply runtime-supported conditional checks
  z.string().length(2, { when: () => false }),
  // @ts-expect-error JavaScript callers can supply runtime-supported conditional checks
  z.number().gt(1, { when: () => false }),
  // @ts-expect-error JavaScript callers can supply runtime-supported conditional checks
  z.number().max(2, { when: () => false }),
  z.string().regex(/hi/),
  z.string().trim(),
  z.email(),
  z.iso.datetime(),
  z.iso.datetime({ offset: true, precision: 6 }),
  z.iso.datetime({ offset: true, local: true, precision: 3 }),
  z.string().datetime({ offset: true, precision: 3 }),
  z.iso.datetime({ offset: true, precision: 3 }).refine(() => true),
  z.number().int(),
  z.string().default('x'),
  z.string().refine((v) => v.length > 0),
])('rejects checks that cannot be represented (%#. case)', (schema) => {
  expect(() =>
    compile({
      ...graph,
      actions: {
        addAccountReview: {
          ...AddAccountReview,
          input: z.object({ value: schema }),
        },
      },
    }),
  ).toThrow('Unsupported');
});

it.each([
  { minLength: -1 },
  { maxLength: 1.5 },
  { minimum: 2 },
  { exclusiveMaximum: Infinity },
  { pattern: '.*' },
  { format: 'date' },
  { type: 'number', format: 'timestamp' },
])(
  'rejects invalid or mismatched discovery constraints (%#. case)',
  (change) => {
    const manifest = structuredClone(compile(graph).manifest);

    Object.assign(manifest.actions![0]!.input.note!, change);
    expect(() => validateManifest(manifest)).toThrow();
  },
);

it('compiles declared error details and rejects unsupported error schemas and unsafe codes', () => {
  const action = {
    ...AddAccountReview,
    errors: {
      inactive: z.object({}),
      limit: z.object({ limit: z.number().min(1).max(100) }),
    },
  };

  expect(
    compile({ ...graph, actions: { addAccountReview: action } }).manifest
      .actions![0]!.errors,
  ).toEqual({
    inactive: {},
    limit: {
      limit: {
        type: 'number',
        optional: false,
        nullable: false,
        minimum: 1,
        maximum: 100,
      },
    },
  });

  for (const errors of [
    { reason: z.object({ value: z.string().transform(Number) }) },
    { constructor: z.object({}) },
  ])
    expect(() =>
      compile({
        ...graph,
        actions: { addAccountReview: { ...action, errors } },
      }),
    ).toThrow();
});

// Check compiled definitions and externally supplied manifests independently.
it.each([
  z.string().min(5).max(2),
  z.number().min(5).max(2),
  z.number().gt(3).lt(3),
  z.number().min(3).lt(3),
  z.number().gt(3).max(3),
])('rejects impossible authoring bounds (%#. case)', (schema) => {
  expect(() =>
    compile({
      ...graph,
      actions: {
        addAccountReview: {
          ...AddAccountReview,
          input: z.object({ value: schema }),
        },
      },
    }),
  ).toThrow('Unsatisfiable');
});

it.each([
  { type: 'string', minLength: 5, maxLength: 2 },
  { type: 'number', minimum: 5, maximum: 2 },
  { type: 'number', exclusiveMinimum: 3, exclusiveMaximum: 3 },
  { type: 'number', minimum: 3, exclusiveMaximum: 3 },
  { type: 'number', exclusiveMinimum: 3, maximum: 3 },
])('rejects impossible loaded bounds (%#. case)', (bounds) => {
  const manifest = JSON.parse(JSON.stringify(compile(graph).manifest));

  manifest.actions[0].input.note = {
    optional: false,
    nullable: false,
    ...bounds,
  };
  expect(() => validateManifest(manifest)).toThrow('Unsatisfiable');
});

it('allows equal inclusive bounds and weaker exclusive bounds', () => {
  const model = compile({
    ...graph,
    actions: {
      addAccountReview: {
        ...AddAccountReview,
        input: z.object({
          value: z.number().min(3).max(3).gt(2).lt(4),
        }),
      },
    },
  });

  expect(accepts(model.manifest.actions![0]!.input.value!, 3)).toBe(true);
});
