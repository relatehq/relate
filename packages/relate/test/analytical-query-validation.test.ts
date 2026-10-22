import { expect, it } from 'vitest';
import { validateAuthorizedDatasetQuery } from 'relate/connectors';
import type {
  AuthorizedDatasetQuery,
  DatasetResource,
} from 'relate/connectors';

function query(): AuthorizedDatasetQuery {
  return {
    resource: {} as DatasetResource,
    keys: [{ type: { type: 'timestamp', precision: 6 } }],
    correlation: [{ column: 'occurredAt', key: 0 }],
    slots: [
      {
        values: [
          {
            type: 'timestamp',
            precision: 6,
            value: '2026-10-22T00:00:00.000000Z',
          },
        ],
        valid: [true],
      },
    ],
    aggregates: [
      {
        aggregate: 'count',
        argument: '*',
        distinct: false,
        result: { type: 'int64', nullable: false },
      },
    ],
  };
}

it('allows empty slots for parameter budgeting and exact timestamp slots for execution', () => {
  const input = query();

  expect(() =>
    validateAuthorizedDatasetQuery({ ...input, slots: [] }, ['occurredAt']),
  ).not.toThrow();
  expect(() =>
    validateAuthorizedDatasetQuery(input, ['occurredAt']),
  ).not.toThrow();
});

it.each([
  ['missing keys', { keys: [] }],
  ['missing correlation', { correlation: [] }],
  ['missing aggregates', { aggregates: [] }],
  ['negative key', { correlation: [{ column: 'occurredAt', key: -1 }] }],
  ['fractional key', { correlation: [{ column: 'occurredAt', key: 0.5 }] }],
  ['out of range key', { correlation: [{ column: 'occurredAt', key: 1 }] }],
  ['unmapped column', { correlation: [{ column: 'secret', key: 0 }] }],
  ['missing slot value', { slots: [{ values: [], valid: [true] }] }],
  [
    'missing mask',
    {
      slots: [
        {
          values: [{ type: 'timestamp', precision: 6, value: null }],
          valid: [],
        },
      ],
    },
  ],
  [
    'inexact timestamp type',
    {
      slots: [
        {
          values: [{ type: 'timestamp', precision: 3, value: null }],
          valid: [true],
        },
      ],
    },
  ],
  [
    'wrong key type',
    { slots: [{ values: [{ type: 'string', value: 'x' }], valid: [true] }] },
  ],
])('rejects %s before rendering', (_name, patch) => {
  const input = { ...query(), ...patch } as AuthorizedDatasetQuery;

  expect(() => validateAuthorizedDatasetQuery(input, ['occurredAt'])).toThrow(
    'Invalid authorized analytical query',
  );
});

it.each([
  ['unknown aggregate', { aggregate: 'median' }],
  ['distinct non-count', { aggregate: 'min', distinct: true }],
  ['distinct star', { distinct: true }],
  ['non-count star', { aggregate: 'sum' }],
  [
    'unmapped operand',
    {
      argument: { kind: 'column', column: 'secret', type: { type: 'string' } },
    },
  ],
  ['unknown operand', { argument: { kind: 'sql', sql: 'unsafe' } }],
  [
    'out of range operand key',
    { argument: { kind: 'key', key: 1, type: { type: 'string' } } },
  ],
  ['unknown comparison', { predicate: { kind: 'compare', op: 'LIKE' } }],
  ['empty boolean', { predicate: { kind: 'boolean', op: 'and', args: [] } }],
  [
    'unknown boolean',
    { predicate: { kind: 'boolean', op: 'xor', args: [{}] } },
  ],
  [
    'multiple NOT operands',
    { predicate: { kind: 'boolean', op: 'not', args: [{}, {}] } },
  ],
  [
    'nested unmapped column',
    {
      predicate: {
        kind: 'boolean',
        op: 'not',
        args: [
          {
            kind: 'null',
            not: false,
            value: {
              kind: 'column',
              column: 'secret',
              type: { type: 'string' },
            },
          },
        ],
      },
    },
  ],
])('rejects %s in aggregate expressions', (_name, patch) => {
  const input = query();
  const malformed = {
    ...input,
    aggregates: [{ ...input.aggregates[0], ...patch }],
  } as unknown as AuthorizedDatasetQuery;

  expect(() =>
    validateAuthorizedDatasetQuery(malformed, ['occurredAt']),
  ).toThrow('Invalid authorized analytical query');
});
