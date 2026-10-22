import type {
  ResolvedAggregate,
  ResolvedAggregateLeaf,
} from 'relate/connectors';
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

it.each([
  ['COUNT(*)', { type: 'int64', nullable: false }],
  ['COUNT(DISTINCT text)', { type: 'int64', nullable: false }],
  ['SUM(small)', { type: 'int64', nullable: true }],
  ['SUM(large)', { type: 'int64', nullable: true }],
  ['SUM(amount)', { type: 'float64', nullable: true }],
  ['AVG(large)', { type: 'float64', nullable: true }],
  ['MIN(small)', { type: 'int32', nullable: true }],
  ['MAX(text)', { type: 'string', nullable: true }],
  ['MIN(enabled)', { type: 'boolean', nullable: true }],
  ['MAX(preciseAt)', { type: 'timestamp', precision: 6, nullable: true }],
  [
    'COALESCE(SUM(large), 9007199254740993)',
    { type: 'int64', nullable: false },
  ],
])('infers the portable result of %s', async (aggregate, result) => {
  const prepared = await prepare(`SELECT ${aggregate} FROM self.events`);

  expect(prepared.aggregate.result).toEqual(result);
  expect(prepared.dependencies).toEqual([
    { id: 'customer.key', type: { type: 'string' }, correlation: true },
  ]);
});

it('retains exact int64 literals and explicitly types constant numeric comparisons', async () => {
  const prepared = await prepare(
    'SELECT COALESCE(SUM(large), 9007199254740993) FROM self.events WHERE 2 < 10',
  );

  expect(leaf(prepared.aggregate).fallback).toEqual({
    type: 'int64',
    value: 9007199254740993n,
  });
  expect(leaf(prepared.aggregate).predicate).toEqual({
    kind: 'compare',
    op: '<',
    left: { kind: 'value', value: { type: 'int64', value: 2n } },
    right: { kind: 'value', value: { type: 'int64', value: 10n } },
  });
});

it.each([
  ['small', 42, { type: 'int32', value: 42 }],
  ['large', '9007199254740993', { type: 'int64', value: 9007199254740993n }],
  ['amount', 12.5, { type: 'float64', value: 12.5 }],
  ['enabled', false, { type: 'boolean', value: false }],
  ['text', 'login', { type: 'string', value: 'login' }],
  [
    'at',
    '2026-10-01T01:00:00+01:00',
    { type: 'timestamp', precision: 3, value: '2026-10-01T00:00:00.000Z' },
  ],
  [
    'preciseAt',
    '2026-10-01T00:00:00.123456Z',
    { type: 'timestamp', precision: 6, value: '2026-10-01T00:00:00.123456Z' },
  ],
])('infers and validates a %s parameter', async (column, value, expected) => {
  const prepared = await prepare(
    `SELECT COUNT(*) FROM self.events WHERE ${column} = $value`,
    { value },
  );

  expect(prepared.parameters.value).toEqual(expected);
});

it('propagates parameter types across comparisons and aggregate arguments', async () => {
  const prepared = await prepare(
    'SELECT MIN($a) FROM self.events WHERE $a = $b AND $b = large',
    { a: '9007199254740993', b: '2' },
  );

  expect(prepared.aggregate.result).toEqual({ type: 'int64', nullable: true });
  expect(prepared.parameterTypes).toEqual({
    a: { type: 'int64' },
    b: { type: 'int64' },
  });
});

it('accepts exact self timestamp comparisons across precisions and reuses dependency indexes', async () => {
  const prepared = await prepare(
    'SELECT MAX(preciseAt) FROM self.events WHERE preciseAt >= self.since AND customerId = self.externalId',
  );

  expect(prepared.dependencies).toEqual([
    { id: 'customer.key', type: { type: 'string' }, correlation: true },
    {
      id: 'customer.since',
      type: { type: 'timestamp', precision: 3 },
      correlation: false,
    },
  ]);
});

it('folds unquoted names and preserves quoted names exactly', async () => {
  expect(
    (await prepare('SELECT MAX(PRECISEAT) FROM self.EVENTS')).aggregate.result
      .type,
  ).toBe('timestamp');
  expect(
    (await prepare('SELECT MAX("preciseAt") FROM self."events"')).aggregate
      .result.type,
  ).toBe('timestamp');
  await expect(
    prepare('SELECT MAX("preciseat") FROM self.events'),
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ problem: 'unknown-property' })],
  });
});

it.each([
  ['SELECT SUM(text) FROM self.events', {}],
  ['SELECT COUNT(*) FROM self.events WHERE small = large', {}],
  [
    'SELECT COUNT(*) FROM self.events WHERE small = $x AND large = $x',
    { x: 1 },
  ],
  [
    'SELECT COUNT(*) FROM self.events WHERE at = $x AND preciseAt = $x',
    { x: '2026-10-01T00:00:00Z' },
  ],
  ['SELECT COUNT(*) FROM self.events WHERE $a < $b', { a: 1, b: 2 }],
  ['SELECT MIN($a) FROM self.events', { a: 1 }],
  ['SELECT COUNT(*) FROM self.events WHERE small = $x', {}],
  ['SELECT COUNT(*) FROM self.events WHERE small = $x', { x: '42' }],
  [
    'SELECT COUNT(*) FROM self.events WHERE large = $x',
    { x: 9007199254740992 },
  ],
  ['SELECT COUNT(*) FROM self.events WHERE at = $x', { x: '2026-10-01' }],
  ['SELECT COUNT(*) FROM self.events WHERE small = $x', { x: null }],
  ['SELECT COUNT(*) FROM self.events WHERE text = $x', { x: {} }],
  ['SELECT COUNT(*) FROM self.events WHERE small = $x', { x: NaN }],
  ['SELECT COUNT(*) FROM self.events WHERE large = $x', { x: 1n }],
  ['SELECT COUNT(*) FROM self.events', { unused: 1 }],
  ['SELECT COUNT(*) FROM self.events WHERE text = $x', { x: 'x'.repeat(1024) }],
  ['SELECT COUNT(*) FROM self.events WHERE at = NULL', {}],
  ['SELECT COUNT(*) FROM self.events WHERE at = self.count', {}],
  ['SELECT COUNT(*) FROM self.events WHERE text = self.list', {}],
  ["SELECT COUNT(*) FROM self.events WHERE small = '1.5'", {}],
  ['SELECT COALESCE(SUM(large), 9223372036854775808) FROM self.events', {}],
])(
  'rejects invalid preparation %# before execution',
  async (sql, parameters) => {
    await expect(prepare(sql, parameters)).rejects.toBeInstanceOf(
      AnalyticalPreparationError,
    );
  },
);

it('types string literals from their column context and accepts NULL only in null checks', async () => {
  const prepared = await prepare(
    "SELECT COUNT(*) FROM self.events WHERE preciseAt >= '2026-10-01T00:00:00Z' AND NULL IS NULL",
  );

  expect(JSON.stringify(leaf(prepared.aggregate).predicate)).toContain(
    '2026-10-01T00:00:00.000000Z',
  );
});

it('does not mutate the supplied scope or expose values in diagnostics', async () => {
  const view = scope();
  const before = structuredClone(view);

  await prepare(
    'SELECT MAX(at) FROM self.events WHERE at >= self.since',
    undefined,
    view,
  );
  expect(view).toEqual(before);

  try {
    await prepare('SELECT COUNT(*) FROM self.events WHERE small = $secret', {
      secret: 'credential-do-not-echo',
    });
    expect.fail('Expected preparation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyticalPreparationError);
    expect(JSON.stringify(error)).not.toContain('credential-do-not-echo');
  }
});

it('enforces host expression and parameter limits independently of the parser', async () => {
  const parser = await createSqlParser();
  const base = {
    parser,
    scope: scope(),
    expression: {
      sql: 'SELECT COUNT(*) FROM self.events WHERE text = $x',
      parameters: { x: 'éé' },
    },
  };

  expect(() => prepareExpression({ ...base, maxSqlBytes: 10 })).toThrow(
    'SQL size',
  );
  expect(() => prepareExpression({ ...base, maxParameterBytes: 5 })).toThrow(
    'value size',
  );
  expect(() => prepareExpression({ ...base, maxParameters: 0 })).toThrow(
    'Invalid analytical',
  );
  expect(() =>
    prepareExpression({
      ...base,
      expression: { ...base.expression, parameters: { x: 'a', y: 'b' } },
      maxParameters: 1,
    }),
  ).toThrow('parameter limit');
  expect(() => prepareExpression({ ...base, declared: true })).toThrow(
    'Declared calculations',
  );
});

it.each(['2147483647.0000000001', '1e-9999', '1e9999'])(
  'rejects fractional or out-of-range integer-context literals: %s',
  async (value) => {
    await expect(
      prepare(`SELECT COUNT(*) FROM self.events WHERE small = ${value}`),
    ).rejects.toBeInstanceOf(AnalyticalPreparationError);
  },
);

it('accepts exact decimal/exponent integer literals without rounding', async () => {
  const prepared = await prepare(
    'SELECT COALESCE(SUM(large), 90071992547409930e-1) FROM self.events WHERE small = 42.000',
  );

  expect(leaf(prepared.aggregate).fallback).toEqual({
    type: 'int64',
    value: 9007199254740993n,
  });
  expect(leaf(prepared.aggregate).predicate).toMatchObject({
    right: { kind: 'value', value: { type: 'int32', value: 42 } },
  });
});

function leaf(value: ResolvedAggregate): ResolvedAggregateLeaf {
  if (value.aggregate === 'expression')
    throw new Error('Expected a single aggregate');

  return value;
}

it('collects authorization dependencies from every formula branch and aggregate filter', async () => {
  const view = scope();
  const denied = {
    ...view,
    associations: view.associations.map((association) => ({
      ...association,
      columns: association.columns.map((column) => ({
        ...column,
        readable: column.name !== 'enabled',
      })),
    })),
  };
  const expression = await prepare(
    'SELECT SUM(small) / NULLIF(COUNT(*) FILTER (WHERE enabled), 0) FROM self.events WHERE at >= self.since',
    undefined,
    denied,
  );

  expect(expression.forbidden).toBe(true);
  expect(expression.columns).toEqual(
    expect.arrayContaining(['events.small', 'events.enabled', 'events.at']),
  );
  expect(expression.dependencies).toContainEqual({
    id: 'customer.since',
    type: { type: 'timestamp', precision: 3 },
    correlation: false,
  });
});

it.each([
  'SUM(small) + MAX(text)',
  'COUNT(*) / self.count',
  'COUNT(*) + self.since',
  'COUNT(*) + small',
  'SUM(COUNT(*))',
  'COUNT(*) + random()',
  'COUNT(*) / (SELECT COUNT(*) FROM self.events)',
])('rejects unsafe or nonnumeric formula %s', async (expression) => {
  await expect(
    prepare(`SELECT ${expression} FROM self.events`),
  ).rejects.toBeInstanceOf(AnalyticalPreparationError);
});
