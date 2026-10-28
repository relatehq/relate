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
export type PostgresPlan = AnalyticalSqlPlan<string | number | boolean | null>;

const dialect: AnalyticalSqlDialect<string | number | boolean | null> = {
  bind(value, position) {
    const encoded = encodeAnalyticalValue(value.value, {
      ...value,
      nullable: true,
    });

    // ISO year zero is PostgreSQL 1 BC; retain the same instant and precision.
    const converted =
      value.type === 'timestamp' &&
      typeof encoded === 'string' &&
      encoded.startsWith('0000-')
        ? `0001-${encoded.slice(5)} BC`
        : encoded;
    const sqlType = {
      string: 'pg_catalog.text',
      boolean: 'pg_catalog.bool',
      int32: 'pg_catalog.int4',
      int64: 'pg_catalog.int8',
      float64: 'pg_catalog.float8',
      timestamp: 'pg_catalog.timestamptz',
    }[value.type];

    return { sql: `$${position}::${sqlType}`, value: converted };
  },
  operand(text, type) {
    return type === 'string' ? `(${text} COLLATE pg_catalog."C")` : text;
  },
  equality(left, right, type) {
    const indexed = `${left} OPERATOR(pg_catalog.=) ${right}`;

    // Keep index use and exact scope under nondeterministic collations.
    return type === 'string'
      ? `(${indexed} AND (${left} COLLATE pg_catalog."C") OPERATOR(pg_catalog.=) (${right} COLLATE pg_catalog."C"))`
      : `(${indexed})`;
  },
  operator(op) {
    return `OPERATOR(pg_catalog.${op})`;
  },
  nullif(left, right) {
    // NULLIF resolves `=` through search_path; evaluate each argument once.
    return `(SELECT CASE WHEN z.l OPERATOR(pg_catalog.=) z.r THEN NULL ELSE z.l END FROM (SELECT ${left} AS l, ${right} AS r) AS z)`;
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
    return `pg_catalog.${name}(${aggregate.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE ${filter})`;
  },
  timestamp(value, precision, bind) {
    const fraction = precision === 3 ? 'MS' : 'US';

    const invalid = bind({ type: 'string', value: 'infinity' });
    const zone = bind({ type: 'string', value: 'UTC' });
    const format = bind({
      type: 'string',
      value: `YYYY-MM-DD"T"HH24:MI:SS.${fraction}"Z"AD`,
    });

    return `CASE WHEN NOT pg_catalog.isfinite(${value}) THEN ${invalid} ELSE pg_catalog.to_char(${value} AT TIME ZONE ${zone}, ${format}) END`;
  },
  timestampParameters: 3,
  checked,
};

export function render(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  resource: SelectedDataset,
  slots: AuthorizedDatasetQuery['slots'],
): PostgresPlan {
  return renderAnalyticalQuery(query, resource, slots, dialect);
}

export function parameterBudget(query: Omit<AuthorizedDatasetQuery, 'slots'>) {
  return analyticalParameterBudget(query, dialect);
}
