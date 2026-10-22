import { expect, it } from 'vitest';
import {
  analyticalParameterBudget,
  renderAnalyticalQuery,
  quoteSqlIdentifier,
  encodeAnalyticalValue,
} from 'relate/analytics';
import type { AnalyticalSqlDialect } from 'relate/analytics';
import type {
  AuthorizedDatasetQuery,
  DatasetResource,
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
