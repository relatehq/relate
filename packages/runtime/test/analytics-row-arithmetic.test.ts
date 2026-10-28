import { expect, it } from 'vitest';
import { createSqlParser } from '@relate/sql-parser';
import type { AnalyticalExpression, LogicalType } from 'relate/analytics';
import {
  prepareExpression,
  AnalyticalPreparationError,
} from '../src/analytics/index.js';
import type { ActorAssociations } from '../src/analytics/index.js';

function scope(): ActorAssociations {
  const scalars: Record<string, LogicalType> = {
    customerId: { type: 'string' },
    text: { type: 'string' },
    small: { type: 'int32' },
    large: { type: 'int64' },
    amount: { type: 'float64' },
    enabled: { type: 'boolean' },
    at: { type: 'timestamp', precision: 3 },
    preciseAt: { type: 'timestamp', precision: 6 },
  };

  return {
    properties: [
      {
        id: 'customer.key',
        name: 'externalId',
        schema: { type: 'string', nullable: false },
        readable: true,
        calculated: false,
      },
      {
        id: 'customer.since',
        name: 'since',
        schema: { type: 'timestamp', precision: 3, nullable: true },
        readable: true,
        calculated: false,
      },
      { id: 'customer.count', name: 'count', readable: true, calculated: true },
      { id: 'customer.list', name: 'list', readable: true, calculated: false },
    ],
    associations: [
      {
        id: 'customer.events',
        name: 'events',
        datasetDefinitionId: 'events',
        on: [
          {
            columnDefinitionId: 'events.customerId',
            propertyDefinitionId: 'customer.key',
          },
        ],
        columns: Object.entries(scalars).map(([name, type]) => ({
          id: `events.${name}`,
          name,
          schema: { ...type, nullable: true },
          readable: true,
        })),
      },
    ],
  };
}

async function prepare(
  sql: string,
  parameters?: Record<string, unknown>,
  view = scope(),
) {
  return prepareExpression({
    parser: await createSqlParser(),
    scope: view,
    expression: {
      sql,
      ...(parameters
        ? {
            parameters: parameters as NonNullable<
              AnalyticalExpression['parameters']
            >,
          }
        : {}),
    },
  });
}

// Inference table from specs/2026-10-28-row-arithmetic.md, with
// large = clicks (int64), small (int32) and amount = rate (float64).
it.each([
  ['SUM(large * $scale)', { scale: 2 }, { type: 'int64' }],
  ['SUM(large * (1.0 * $scale))', { scale: 0.5 }, { type: 'float64' }],
  ['SUM(large * $scale) + $scale', { scale: 2 }, { type: 'int64' }],
  ['SUM(large / $scale)', { scale: 2 }, { type: 'int64' }],
  ['SUM(small * $scale)', { scale: 2 }, { type: 'int32' }],
  [
    'SUM(large * $scale) FILTER (WHERE amount = $scale)',
    { scale: 0.5 },
    { type: 'float64' },
  ],
  [
    'SUM(amount * $scale) FILTER (WHERE small = $scale)',
    { scale: 2 },
    { type: 'int32' },
  ],
  ['SUM(large) * $scale', { scale: 0.5 }, { type: 'float64' }],
  ['SUM($scale * large)', { scale: 2 }, { type: 'int64' }],
])('types the parameter of %s', async (aggregate, parameters, type) => {
  const prepared = await prepare(
    `SELECT ${aggregate} FROM self.events`,
    parameters,
  );

  expect(prepared.parameterTypes.scale).toEqual(type);
});

it.each([
  ['SUM(large * $scale)', { scale: 0.5 }, 'Parameter does not match'],
  ['SUM(small * $scale)', { scale: 3000000000 }, 'Parameter does not match'],
  [
    'SUM(amount * $scale) FILTER (WHERE small = $scale)',
    { scale: 0.5 },
    'Parameter does not match',
  ],
  [
    'SUM(large * $scale) + SUM(amount * $scale)',
    { scale: 2 },
    'conflicting types',
  ],
  [
    'SUM(amount * $scale) + SUM(large * $scale)',
    { scale: 2 },
    'conflicting types',
  ],
  ['SUM($a * $b)', { a: 1, b: 2 }, 'Cannot infer'],
  ['SUM(($a * $b) * 1.0)', { a: 1, b: 2 }, 'Cannot infer'],
  ['SUM(text * 2)', undefined, 'numeric operands'],
  ['SUM(large * TRUE)', undefined, 'numeric operands'],
  ["SUM(large * '2')", undefined, 'numeric operands'],
  ['SUM(at + 1)', undefined, 'numeric operands'],
  ['SUM(large * NULL)', undefined, 'NULL literals'],
])('rejects %s during preparation', async (aggregate, parameters, message) => {
  const error = await prepare(
    `SELECT ${aggregate} FROM self.events`,
    parameters,
  ).catch((error: unknown) => error);

  expect(error).toBeInstanceOf(AnalyticalPreparationError);
  expect((error as AnalyticalPreparationError).message).toContain(message);
});

it('types every row node by promotion and keeps literal spelling', async () => {
  const prepared = await prepare(
    'SELECT SUM((large + 1) * 1.0 + small / 2) FROM self.events',
  );

  expect(prepared.aggregate).toMatchObject({
    aggregate: 'sum',
    result: { type: 'float64', nullable: true },
    argument: {
      kind: 'arithmetic',
      op: '+',
      type: { type: 'float64' },
      left: {
        op: '*',
        type: { type: 'float64' },
        left: {
          op: '+',
          type: { type: 'int64' },
          right: { kind: 'value', value: { type: 'int64', value: 1n } },
        },
        right: { kind: 'value', value: { type: 'float64', value: 1 } },
      },
      right: {
        op: '/',
        type: { type: 'float64' },
        left: { kind: 'column', column: 'small', type: { type: 'int32' } },
      },
    },
  });
});

it.each([
  ['SUM(small + small)', { type: 'int64', nullable: true }],
  ['AVG(large * 2)', { type: 'float64', nullable: true }],
  ['MIN(small * 2)', { type: 'int64', nullable: true }],
  ['MAX(large / 2)', { type: 'float64', nullable: true }],
  ['COUNT(large - 1)', { type: 'int64', nullable: false }],
  ['COALESCE(SUM(large * 2), 0)', { type: 'int64', nullable: false }],
])(
  'infers the portable result of row arithmetic %s',
  async (aggregate, result) => {
    const prepared = await prepare(`SELECT ${aggregate} FROM self.events`);

    expect(prepared.aggregate.result).toEqual(result);
  },
);

it('authorizes every row operand, including self properties', async () => {
  const prepared = await prepare(
    'SELECT SUM(amount * (small - self.rate)) FROM self.events',
    undefined,
    {
      ...scope(),
      properties: [
        ...scope().properties,
        {
          id: 'customer.rate',
          name: 'rate',
          schema: { type: 'int64', nullable: false },
          readable: true,
          calculated: false,
        },
      ],
    },
  );

  expect(prepared.columns).toEqual(
    expect.arrayContaining(['events.amount', 'events.small']),
  );
  expect(prepared.dependencies.map((dependency) => dependency.id)).toEqual([
    'customer.key',
    'customer.rate',
  ]);
});

it('rejects arithmetic inside COUNT(DISTINCT ...)', async () => {
  await expect(
    prepare('SELECT COUNT(DISTINCT large + 1) FROM self.events'),
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ problem: 'not-supported' })],
  });
});
