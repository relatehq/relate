import { expect, it } from 'vitest';
import {
  analyticalParameterBudget,
  renderAnalyticalQuery,
  quoteSqlIdentifier,
  encodeAnalyticalValue,
} from 'relate/analytics';
import type {
  AnalyticalSqlDialect,
  ComputedResultType,
} from 'relate/analytics';
import type {
  AuthorizedDatasetQuery,
  DatasetResource,
  ResolvedAggregateLeaf,
  ResolvedOperand,
  ResolvedScalarExpression,
} from 'relate/connectors';

function request(): AuthorizedDatasetQuery {
  return {
    resource: {} as DatasetResource,
    keys: [{ type: { type: 'string' } }],
    correlation: [{ column: 'customer', key: 0 }],
    slots: [
      {
        values: [{ type: 'string', value: "x'); DROP TABLE events;--" }],
        valid: [true, false],
      },
    ],
    aggregates: [
      {
        aggregate: 'max',
        distinct: false,
        argument: {
          kind: 'value',
          value: {
            type: 'timestamp',
            precision: 6,
            value: '2300-01-01T00:00:00.123456Z',
          },
        },
        predicate: {
          kind: 'boolean',
          op: 'and',
          args: [
            {
              kind: 'compare',
              op: '=',
              left: { kind: 'key', key: 0, type: { type: 'string' } },
              right: {
                kind: 'value',
                value: { type: 'string', value: 'match' },
              },
            },
            {
              kind: 'null',
              not: false,
              value: { kind: 'value', value: { type: 'string', value: null } },
            },
            {
              kind: 'boolean',
              op: 'not',
              args: [
                {
                  kind: 'compare',
                  op: '<>',
                  left: {
                    kind: 'column',
                    column: 'customer',
                    type: { type: 'string' },
                  },
                  right: {
                    kind: 'value',
                    value: { type: 'string', value: 'other' },
                  },
                },
              ],
            },
          ],
        },
        fallback: {
          type: 'timestamp',
          precision: 6,
          value: '0001-01-01T00:00:00.000000Z',
        },
        result: { type: 'timestamp', precision: 6, nullable: false },
      },
      {
        aggregate: 'count',
        distinct: false,
        argument: '*',
        result: { type: 'int64', nullable: false },
      },
    ],
  };
}

const dialect: AnalyticalSqlDialect = {
  bind(value, position) {
    return {
      sql: `$${position}`,
      value: encodeAnalyticalValue(value.value, { ...value, nullable: true }),
    };
  },
  operand(sql) {
    return sql;
  },
  operator(op) {
    return op;
  },
  aggregate(aggregate, argument, filter) {
    return `${aggregate.aggregate}(${argument}) FILTER (WHERE ${filter})`;
  },
  timestamp(sql, _precision, bind) {
    return `format(${sql}, ${bind({ type: 'string', value: 'format' })})`;
  },
  timestampParameters: 1,
};
const resource = { table: 'events', columns: { customer: 'customer_id' } };

it('counts all bound positions without invoking renderer or scalar encoding hooks', () => {
  const query = request();
  const budget = analyticalParameterBudget(query, { timestampParameters: 1 });

  expect(budget).toEqual({ fixed: 7, perSlot: 4 });
  const plan = renderAnalyticalQuery(query, resource, query.slots, dialect);

  expect(plan.values).toHaveLength(budget.fixed + budget.perSlot);
  expect(plan.sql).not.toContain('DROP TABLE');
  expect(plan.sql).toContain('d."customer_id" = k.k0');
});

it('rejects malformed authorized structures through the common validation path', () => {
  const valid = request();
  const cases = [
    { ...valid, correlation: [{ column: 'customer', key: 4 }] },
    { ...valid, correlation: [{ column: 'missing', key: 0 }] },
    { ...valid, slots: [{ ...valid.slots[0]!, valid: [true] }] },
    { ...valid, aggregates: [{ ...valid.aggregates[0]!, distinct: true }] },
    {
      ...valid,
      aggregates: [{ ...valid.aggregates[0]!, argument: '*' as const }],
    },
    {
      ...valid,
      aggregates: [
        {
          ...valid.aggregates[0]!,
          predicate: { kind: 'boolean' as const, op: 'not' as const, args: [] },
        },
      ],
    },
  ];

  for (const query of cases)
    expect(() =>
      renderAnalyticalQuery(query, resource, query.slots, dialect),
    ).toThrow('Invalid authorized analytical query');

  expect(quoteSqlIdentifier('a"b')).toBe('"a""b"');
  expect(() => quoteSqlIdentifier('a\0b')).toThrow('Invalid SQL identifier');
});

it('budgets nested formulas and binds aggregate inputs before projection values', () => {
  const query = request();
  const count = (value: number) => ({
    kind: 'aggregate' as const,
    value: {
      aggregate: 'count' as const,
      distinct: false,
      argument: {
        kind: 'value' as const,
        value: { type: 'int32' as const, value },
      },
      result: { type: 'int64' as const, nullable: false },
    },
  });
  const input: AuthorizedDatasetQuery = {
    ...query,
    slots: [{ ...query.slots[0]!, valid: [true] }],
    aggregates: [
      {
        aggregate: 'expression',
        result: { type: 'float64', nullable: true },
        expression: {
          kind: 'binary',
          op: '/',
          left: count(11),
          right: {
            kind: 'binary',
            op: '+',
            left: count(22),
            right: {
              kind: 'operand',
              value: { kind: 'value', value: { type: 'float64', value: 33 } },
            },
          },
        },
      },
    ],
  };
  const budget = analyticalParameterBudget(input, dialect);
  const plan = renderAnalyticalQuery(input, resource, input.slots, {
    ...dialect,
    bind: (value) => ({
      sql: '?',
      value: encodeAnalyticalValue(value.value, { ...value, nullable: true }),
    }),
  });

  expect(budget).toEqual({ fixed: 5, perSlot: 3 });
  expect(plan.values).toEqual([
    0,
    "x'); DROP TABLE events;--",
    true,
    11,
    22,
    '0',
    '0',
    33,
  ]);
  expect(plan.sql.match(/\?/g)).toHaveLength(plan.values.length);
  const forged = structuredClone(input);

  Object.assign(forged.aggregates[0]!, {
    expression: {
      kind: 'binary',
      op: '; DELETE',
      left: count(1),
      right: count(2),
    },
  });
  expect(() =>
    renderAnalyticalQuery(forged, resource, forged.slots, dialect),
  ).toThrow('Invalid authorized analytical query');
});

function formula(expression: ResolvedScalarExpression): AuthorizedDatasetQuery {
  const query = request();

  return {
    ...query,
    slots: [{ ...query.slots[0]!, valid: [true] }],
    aggregates: [
      {
        aggregate: 'expression',
        result: { type: 'float64', nullable: true },
        expression,
      },
    ],
  };
}

function countLeaf(): ResolvedScalarExpression {
  return {
    kind: 'aggregate',
    value: {
      aggregate: 'count',
      distinct: false,
      argument: '*',
      result: { type: 'int64', nullable: false },
    },
  };
}

it('renders formula operators and NULLIF through the dialect', () => {
  const input = formula({
    kind: 'nullif',
    left: { kind: 'binary', op: '/', left: countLeaf(), right: countLeaf() },
    right: {
      kind: 'binary',
      op: '-',
      left: countLeaf(),
      right: countLeaf(),
    },
  });
  const plan = renderAnalyticalQuery(input, resource, input.slots, {
    ...dialect,
    operator: (op) => `OP(${op})`,
    nullif: (left, right) => `GUARD(${left}, ${right})`,
  });
  const projection = plan.sql.slice(plan.sql.lastIndexOf('SELECT k.slot'));

  expect(projection).toContain(' OP(/) GUARD(');
  expect(projection).toContain(' OP(-) ');
  expect(projection).not.toMatch(/NULLIF|\) [-+*/] /);
});

it('rejects nested formulas and nonnumeric formula leaves', () => {
  const maximum = (
    argument: ResolvedOperand,
    result: ComputedResultType,
  ): ResolvedScalarExpression => ({
    kind: 'aggregate',
    value: { aggregate: 'max', distinct: false, argument, result },
  });
  const cases = [
    formula({
      kind: 'binary',
      op: '+',
      left: countLeaf(),
      right: {
        kind: 'aggregate',
        value: {
          aggregate: 'expression',
          result: { type: 'float64', nullable: true },
          expression: countLeaf(),
        } as unknown as ResolvedAggregateLeaf,
      },
    }),
    formula(
      maximum(
        {
          kind: 'value',
          value: { type: 'timestamp', precision: 3, value: null },
        },
        { type: 'timestamp', precision: 3, nullable: true },
      ),
    ),
    formula({
      kind: 'coalesce',
      left: countLeaf(),
      right: {
        kind: 'operand',
        value: { kind: 'value', value: { type: 'string', value: 'x' } },
      },
    }),
    formula({ kind: 'binary', op: '+', left: countLeaf() } as never),
  ];

  for (const query of cases)
    expect(() =>
      renderAnalyticalQuery(query, resource, query.slots, dialect),
    ).toThrow('Invalid authorized analytical query');
});
