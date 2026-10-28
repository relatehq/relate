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

export type SelectedDataset = SqlDataset & { readonly schema: string };
export type DuckDBPlan = AnalyticalSqlPlan<string | number | boolean | null>;

const dialect: AnalyticalSqlDialect<string | number | boolean | null> = {
  bind(value, position) {
    const encoded = encodeAnalyticalValue(value.value, {
      ...value,
      nullable: true,
    });

    const sqlType = {
      string: 'VARCHAR',
      boolean: 'BOOLEAN',
      int32: 'INTEGER',
      int64: 'BIGINT',
      float64: 'DOUBLE',
      timestamp: 'TIMESTAMP',
      date: 'DATE',
    }[value.type];

    // The driver binds integral numbers as BIGINT, so 1e308 would not bind;
    // shortest round-trip text parses back to the same double.
    return {
      sql: `CAST($${position} AS ${sqlType})`,
      value:
        value.type === 'float64' && encoded !== null
          ? String(encoded)
          : encoded,
    };
  },
  operand(text, type) {
    return type === 'string' ? `(${text} COLLATE "binary")` : text;
  },
  operator(op) {
    return op;
  },
  aggregate(aggregate, argument, filter) {
    const inputType =
      aggregate.argument === '*'
        ? undefined
        : aggregate.argument.kind === 'value'
          ? aggregate.argument.value.type
          : aggregate.argument.type.type;
    const name =
      inputType === 'boolean' && aggregate.aggregate === 'min'
        ? 'BOOL_AND'
        : inputType === 'boolean' && aggregate.aggregate === 'max'
          ? 'BOOL_OR'
          : aggregate.aggregate.toUpperCase();

    // Numeric SUM and AVG use checked accumulation.
    return `"system"."main".${name}(${aggregate.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE ${filter})`;
  },
  timestamp(value, precision, bind) {
    const fraction = precision === 3 ? '%g' : '%f';
    const format = bind({
      type: 'string',
      value: `%Y-%m-%dT%H:%M:%S.${fraction}Z`,
    });

    return `"system"."main".strftime(CAST(${value} AS TIMESTAMP), ${format})`;
  },
  timestampParameters: 1,
  // Infinity and years beyond 9999 render as non-canonical text and fail decoding.
  date(value, bind) {
    const format = bind({ type: 'string', value: '%Y-%m-%d' });

    return `"system"."main".strftime(CAST(${value} AS DATE), ${format})`;
  },
  dateParameters: 1,
  checked,
};

export function render(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  resource: SelectedDataset,
  slots: AuthorizedDatasetQuery['slots'],
): DuckDBPlan {
  return renderAnalyticalQuery(query, resource, slots, dialect);
}

export function parameterBudget(query: Omit<AuthorizedDatasetQuery, 'slots'>) {
  return analyticalParameterBudget(query, dialect);
}
