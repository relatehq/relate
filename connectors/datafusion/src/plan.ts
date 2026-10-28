import {
  analyticalParameterBudget,
  encodeAnalyticalValue,
  renderAnalyticalQuery,
  checkedValue,
} from 'relate/analytics';
import type {
  AnalyticalSqlDialect,
  AnalyticalSqlPlan,
  CheckedArithmeticDialect,
  CheckedInput,
  CheckedType,
  SqlDataset,
} from 'relate/analytics';
import type { AuthorizedDatasetQuery } from 'relate/connectors';

export type DataFusionPlan = AnalyticalSqlPlan<string | null>;

const failed = (sql: string, type: CheckedType) =>
  `relate_${type === 'int64' ? 'i' : 'f'}failed(${sql})`;
const checked: CheckedArithmeticDialect = {
  nodeBinding: 'inline',
  operand: (sql, type) =>
    type === 'float64' ? sql : `CAST(${sql} AS VARCHAR)`,
  node(op, left, right, result) {
    const name = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' }[op];
    const convert = (value: typeof left) =>
      result === 'float64' && value.type === 'int64'
        ? `relate_ifloat(${value.sql})`
        : value.sql;

    return `relate_${result === 'int64' ? 'i' : 'f'}${name}(${convert(left)}, ${convert(right)})`;
  },
  failed,
  flag: (condition, filter) =>
    `MAX(CASE WHEN ${condition} THEN 1 ELSE 0 END) FILTER (WHERE ${filter})`,
  accumulate(aggregate, input, filter) {
    const call = (name: string, transform = (v: string) => v) =>
      `${name}(${checkedValue(input, failed, transform)}) FILTER (WHERE ${filter})`;

    if (aggregate === 'count')
      return { columns: [call('COUNT')], value: ([v]) => v! };

    if (aggregate === 'min' || aggregate === 'max')
      return {
        columns: [
          call(aggregate.toUpperCase(), (v) =>
            input.type === 'int64' ? `CAST(${v} AS BIGINT)` : v,
          ),
        ],
        value: ([v]) => v!,
      };

    if (input.type === 'int64') {
      if (aggregate === 'avg')
        return { columns: [call('relate_iavg')], value: ([v]) => v! };

      return {
        columns: [call('relate_isum')],
        value: ([v]) =>
          `CAST(CASE WHEN relate_ifailed(${v}) THEN NULL ELSE ${v} END AS BIGINT)`,
        failed: ([v]) => `relate_ifailed(${v})`,
      };
    }

    return floatAccumulation(aggregate === 'avg', input, filter);
  },
};

// Scale large floats by an exact power of two before summing. AVG divides before
// restoring the scale, so averaging two maximum finite doubles does not overflow.
function floatAccumulation(
  average: boolean,
  input: CheckedInput,
  filter: string,
) {
  const double = (value: number) => `CAST('${value}' AS DOUBLE)`;
  const big = double(2 ** 512);
  const small = double(2 ** -512);
  const bucket = (large: boolean) =>
    `SUM(${checkedValue(
      input,
      failed,
      (v) =>
        `CASE WHEN ABS(${v}) ${large ? '>=' : '<'} ${big} THEN ${large ? `${v} * ${small}` : v} END`,
    )}) FILTER (WHERE ${filter})`;
  const columns = [bucket(true), bucket(false)];

  if (average)
    columns.push(
      `COUNT(${checkedValue(input, failed, (v) => v)}) FILTER (WHERE ${filter})`,
    );

  const total = ([hi, lo, count]: readonly string[]) => {
    const n = count ? `CAST(NULLIF(${count}, 0) AS DOUBLE)` : double(1);

    return `(COALESCE(${hi}, ${double(0)}) / ${n}) * ${big} + COALESCE(${lo}, ${double(0)}) / ${n}`;
  };
  const empty = ([hi, lo]: readonly string[]) =>
    `${hi} IS NULL AND ${lo} IS NULL`;
  const bad = (refs: readonly string[]) => `relate_ffailed(${total(refs)})`;

  return {
    columns,
    value: (refs: readonly string[]) =>
      `CASE WHEN ${empty(refs)} OR ${bad(refs)} THEN NULL ELSE ${total(refs)} END`,
    failed: (refs: readonly string[]) =>
      `(NOT (${empty(refs)}) AND (${bad(refs)}))`,
  };
}

const dialect: AnalyticalSqlDialect<string | null> = {
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
      timestamp:
        value.type === 'timestamp' && value.precision === 3
          ? 'TIMESTAMP(3)'
          : 'TIMESTAMP(6)',
      date: 'DATE',
    }[value.type];

    return {
      sql: `CAST($${position} AS ${sqlType})`,
      value: encoded === null ? null : String(encoded),
    };
  },
  operand: (sql) => sql,
  operator: (op) => op,
  aggregate(aggregate, argument, filter) {
    const type =
      aggregate.argument === '*'
        ? undefined
        : aggregate.argument.kind === 'value'
          ? aggregate.argument.value.type
          : aggregate.argument.type.type;
    const name =
      type === 'boolean' && aggregate.aggregate === 'min'
        ? 'BOOL_AND'
        : type === 'boolean' && aggregate.aggregate === 'max'
          ? 'BOOL_OR'
          : aggregate.aggregate.toUpperCase();

    return `${name}(${aggregate.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE ${filter})`;
  },
  timestamp: (sql, precision) =>
    `relate_timestamp_${precision === 3 ? 'ms' : 'us'}(${sql})`,
  timestampParameters: 0,
  date: (sql) => `relate_date(${sql})`,
  dateParameters: 0,
  checked,
};

export const parameterBudget = (query: Omit<AuthorizedDatasetQuery, 'slots'>) =>
  analyticalParameterBudget(query, dialect);

export const render = (
  query: AuthorizedDatasetQuery,
  resource: SqlDataset,
): DataFusionPlan =>
  renderAnalyticalQuery(query, resource, query.slots, dialect);
