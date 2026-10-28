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
import { checked } from './checked.js';

export type SelectedDataset = SqlDataset;
export type SqlitePlan = AnalyticalSqlPlan<string | number | bigint | null>;

const dialect: AnalyticalSqlDialect<string | number | bigint | null> = {
  bind(value, position) {
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

    // Numbered binds let one rendered operand appear several times.
    return { sql: `CAST(?${position} AS ${sqlType})`, value: converted };
  },
  operand(text, type, comparison) {
    if (comparison && type === 'timestamp') text = `__relate_instant(${text})`;

    return type === 'string' || type === 'timestamp'
      ? `(${text} COLLATE BINARY)`
      : text;
  },
  equality(left, right, type, correlation) {
    if (correlation && type === 'timestamp') {
      const exact = `__relate_instant(${right})`;
      const millis = `CASE WHEN substr(${exact}, 24, 3) = '000' THEN substr(${exact}, 1, 23) || 'Z' ELSE ${exact} END`;

      return `((${left} COLLATE BINARY) IN (${exact}, ${millis}))`;
    }

    return `${this.operand(left, type, true)} = ${this.operand(right, type, true)}`;
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
  checked,
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
