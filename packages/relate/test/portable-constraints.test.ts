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

  expect(input).toEqual({
    type: 'string',
    optional: false,
    nullable: false,
    minLength: 1,
    maxLength: 4000,
  });
  expect(property.schema).toEqual(input);
});

it.each([
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
  z.string().regex(/hi/),
  z.string().trim(),
  z.email(),
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
