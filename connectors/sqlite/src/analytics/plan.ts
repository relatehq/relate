import {
  encodeAnalyticalValue,
  renderAnalyticalQuery,
  analyticalParameterBudget,
} from 'relate/analytics';
import type {
  AnalyticalSqlDialect,
  AnalyticalSqlPlan,
  SqlDataset,
} from 'relate/analytics';
import type { AuthorizedDatasetQuery } from 'relate/connectors';

export type SelectedDataset = SqlDataset;
export type SqlitePlan = AnalyticalSqlPlan<string | number | bigint | null>;

const dialect: AnalyticalSqlDialect<string | number | bigint | null> = {
  bind(value) {
    const encoded = encodeAnalyticalValue(value.value, {
      ...value,
      nullable: true,
    });
    const converted =
      encoded === null
        ? null
        : value.type === 'int64'
          ? BigInt(encoded as string)
          : typeof encoded === 'boolean'
            ? Number(encoded)
            : encoded;

    const sqlType =
      value.type === 'string' || value.type === 'timestamp'
        ? 'TEXT'
        : value.type === 'float64'
          ? 'REAL'
          : 'INTEGER';

    return { sql: `CAST(? AS ${sqlType})`, value: converted };
  },
  operand(text, type, comparison) {
    if (comparison && type === 'timestamp') text = `__relate_instant(${text})`;

    return type === 'string' || type === 'timestamp'
      ? `(${text} COLLATE BINARY)`
      : text;
  },
  operator(op) {
    return op;
  },
  aggregate(aggregate, argument, filter) {
    return `${aggregate.aggregate.toUpperCase()}(${aggregate.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE ${filter})`;
  },
  timestamp(value) {
    return value;
  },
  timestampParameters: 0,
};

export function render(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  resource: SelectedDataset,
  slots: AuthorizedDatasetQuery['slots'],
): SqlitePlan {
  return renderAnalyticalQuery(query, resource, slots, dialect);
}

export function parameterBudget(query: Omit<AuthorizedDatasetQuery, 'slots'>) {
  return analyticalParameterBudget(query, dialect);
}
