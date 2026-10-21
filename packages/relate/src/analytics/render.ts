import type {
  AuthorizedDatasetQuery,
  ResolvedOperand,
  ResolvedPredicate,
} from './query.js';
import type { LogicalType } from '@relate/protocol';
import type { AnalyticalScalar, TypedValue } from './values.js';

export interface SqlDataset {
  readonly table: string;
  readonly schema?: string;
  readonly columns: Readonly<Record<string, string>>;
}

export interface AnalyticalSqlPlan<
  Value extends AnalyticalScalar | bigint = AnalyticalScalar | bigint,
> {
  readonly sql: string;
  readonly values: readonly Value[];
  readonly slots: number;
  readonly results: readonly AuthorizedDatasetQuery['aggregates'][number]['result'][];
}

function invalid(): never {
  throw new Error('Invalid authorized analytical query');
}

/** Only connector-produced identifiers, fixed syntax, and explicitly typed bound values. */
export function renderAnalyticalQuery<Value extends AnalyticalScalar | bigint>(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  resource: SqlDataset,
  slots: AuthorizedDatasetQuery['slots'],
  dialect: AnalyticalSqlDialect<Value>,
): AnalyticalSqlPlan<Value> {
  const values: Value[] = [];
  const bind = (value: TypedValue): string => {
    const bound = dialect.bind(value, values.length + 1);

    values.push(bound.value);

    return bound.sql;
  };
  const column = (name: string) => {
    if (!Object.hasOwn(resource.columns, name)) invalid();

    return `d.${quoteSqlIdentifier(resource.columns[name]!)}`;
  };
  const operand = (value: ResolvedOperand, comparison = false): string => {
    let text: string;

    if (value.kind === 'column') text = column(value.column);
    else if (value.kind === 'key') {
      if (
        !Number.isSafeInteger(value.key) ||
        value.key < 0 ||
        !query.keys[value.key]
      )
        invalid();

      text = `k.k${value.key}`;
    } else if (value.kind === 'value') text = bind(value.value);
    else return invalid();

    const type = value.kind === 'value' ? value.value.type : value.type.type;

    return dialect.operand(text, type, comparison);
  };
  const predicate = (value: ResolvedPredicate): string => {
    if (value.kind === 'compare') {
      if (!['=', '<>', '<', '<=', '>', '>='].includes(value.op)) invalid();

      return `(${operand(value.left, true)} ${dialect.operator(value.op)} ${operand(value.right, true)})`;
    }

    if (value.kind === 'null')
      return `(${operand(value.value)} IS ${value.not ? 'NOT ' : ''}NULL)`;

    if (
      value.kind !== 'boolean' ||
      !['and', 'or', 'not'].includes(value.op) ||
      !value.args.length
    )
      invalid();

    if (value.op === 'not') {
      if (value.args.length !== 1) invalid();

      return `(NOT ${predicate(value.args[0]!)})`;
    }

    return `(${value.args.map(predicate).join(value.op === 'and' ? ' AND ' : ' OR ')})`;
  };

  if (
    !query.keys.length ||
    !query.correlation.length ||
    !query.aggregates.length
  )
    invalid();

  const names = [
    'slot',
    ...query.keys.map((_, i) => `k${i}`),
    ...query.aggregates.map((_, i) => `m${i}`),
  ];
  const rows = slots.map((slot, index) => {
    if (
      slot.values.length !== query.keys.length ||
      slot.valid.length !== query.aggregates.length
    )
      invalid();

    return `(${[
      bind({ type: 'int32', value: index }),
      ...slot.values.map((value, i) => {
        const type = query.keys[i]!.type;

        if (
          type.type !== value.type ||
          (type.type === 'timestamp' &&
            value.type === 'timestamp' &&
            type.precision !== value.precision)
        )
          invalid();

        return bind(value);
      }),
      ...slot.valid.map((value) => bind({ type: 'boolean', value })),
    ].join(', ')})`;
  });
  const aggregates = query.aggregates.map((aggregate, index) => {
    if (
      !['count', 'sum', 'avg', 'min', 'max'].includes(aggregate.aggregate) ||
      (aggregate.distinct && aggregate.aggregate !== 'count') ||
      (aggregate.argument === '*' &&
        (aggregate.aggregate !== 'count' || aggregate.distinct))
    )
      invalid();

    const argument =
      aggregate.argument === '*' ? '*' : operand(aggregate.argument);
    const filter = aggregate.predicate
      ? ` AND ${predicate(aggregate.predicate)}`
      : '';

    return `${dialect.aggregate(aggregate, argument, `k.m${index}${filter}`)} AS v${index}`;
  });
  const correlation = query.correlation
    .map((pair) => {
      if (
        !Number.isSafeInteger(pair.key) ||
        pair.key < 0 ||
        !query.keys[pair.key]
      )
        invalid();

      const type = query.keys[pair.key]!.type;

      return `${operand({ kind: 'column', column: pair.column, type }, true)} ${dialect.operator('=')} ${operand({ kind: 'key', key: pair.key, type }, true)}`;
    })
    .join(' AND ');
  const projection = query.aggregates.map((aggregate, i) => {
    let value = `a.v${i}`;

    if (aggregate.aggregate === 'count')
      value = `COALESCE(${value}, ${bind({ type: 'int64', value: 0n })})`;
    else if (aggregate.fallback)
      value = `COALESCE(${value}, ${bind(aggregate.fallback)})`;

    if (aggregate.result.type === 'timestamp')
      value = dialect.timestamp(value, aggregate.result.precision, bind);

    return `${value} AS v${i}`;
  });

  // Positional parameters are explicitly typed; physical identifiers stay connector-owned.
  return {
    sql: `WITH keys(${names.join(', ')}) AS (VALUES ${rows.join(', ')}), agg AS (SELECT k.slot, ${aggregates.join(', ')} FROM keys AS k JOIN ${[
      resource.schema,
      resource.table,
    ]
      .filter((name): name is string => name !== undefined)
      .map(quoteSqlIdentifier)
      .join(
        '.',
      )} AS d ON ${correlation} GROUP BY k.slot) SELECT k.slot, ${projection.join(', ')} FROM keys AS k LEFT JOIN agg AS a ON a.slot ${dialect.operator('=')} k.slot ORDER BY k.slot`,
    values,
    slots: slots.length,
    results: query.aggregates.map((aggregate) => ({ ...aggregate.result })),
  };
}

/** Quote a host-selected SQL identifier, never an authored SQL expression. */
export function quoteSqlIdentifier(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error('Invalid SQL identifier');

  return `"${value.replaceAll('"', '""')}"`;
}

/** Dialect-owned syntax; authorization, validation and relational shape stay shared. */
export interface AnalyticalSqlDialect<
  Value extends AnalyticalScalar | bigint = AnalyticalScalar | bigint,
> {
  bind(value: TypedValue, position: number): { sql: string; value: Value };
  operand(sql: string, type: LogicalType['type'], comparison: boolean): string;
  operator(operator: string): string;
  aggregate(
    aggregate: AuthorizedDatasetQuery['aggregates'][number],
    argument: string,
    filter: string,
  ): string;
  timestamp(
    sql: string,
    precision: 3 | 6,
    bind: (value: TypedValue) => string,
  ): string;
  readonly timestampParameters: number;
}

/** Count bound values without rendering SQL or encoding scalar values. */
export function analyticalParameterBudget(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  dialect: Pick<AnalyticalSqlDialect, 'timestampParameters'>,
): { fixed: number; perSlot: number } {
  const operand = (value: ResolvedOperand): number =>
    value.kind === 'value' ? 1 : 0;
  const predicate = (value: ResolvedPredicate): number => {
    if (value.kind === 'compare')
      return operand(value.left) + operand(value.right);

    if (value.kind === 'null') return operand(value.value);

    return value.args.reduce((sum, arg) => sum + predicate(arg), 0);
  };
  const fixed = query.aggregates.reduce(
    (sum, aggregate) =>
      sum +
      (aggregate.argument === '*' ? 0 : operand(aggregate.argument)) +
      (aggregate.predicate ? predicate(aggregate.predicate) : 0) +
      (aggregate.aggregate === 'count' || aggregate.fallback ? 1 : 0) +
      (aggregate.result.type === 'timestamp' ? dialect.timestampParameters : 0),
    0,
  );

  return { fixed, perSlot: 1 + query.keys.length + query.aggregates.length };
}
