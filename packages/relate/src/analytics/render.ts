import { validateAuthorizedDatasetQuery } from './query-validation.js';
import {
  foldRowExpression,
  foldScalarExpression,
  isRowArithmetic,
  scalarLeaves,
} from './scalar.js';
import type {
  AuthorizedDatasetQuery,
  ResolvedAggregate,
  ResolvedAggregateLeaf,
  ResolvedScalarExpression,
  ResolvedOperand,
  ResolvedPredicate,
  ResolvedRowExpression,
} from './query.js';
import type { Aggregate, ArithmeticOperator } from './sql.js';
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

/** Only connector-produced identifiers, fixed syntax, and explicitly typed bound values. */
export function renderAnalyticalQuery<Value extends AnalyticalScalar | bigint>(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  resource: SqlDataset,
  slots: AuthorizedDatasetQuery['slots'],
  dialect: AnalyticalSqlDialect<Value>,
): AnalyticalSqlPlan<Value> {
  validateAuthorizedDatasetQuery(
    { ...query, slots },
    Object.keys(resource.columns),
  );
  const values: Value[] = [];
  const bind = (value: TypedValue): string => {
    const bound = dialect.bind(value, values.length + 1);

    values.push(bound.value);

    return bound.sql;
  };
  const column = (name: string) => {
    return `d.${quoteSqlIdentifier(resource.columns[name]!)}`;
  };
  const operand = (
    value: ResolvedOperand,
    comparison = false,
    raw = false,
  ): string => {
    let text: string;

    if (value.kind === 'column') text = column(value.column);
    else if (value.kind === 'key') text = `k.k${value.key}`;
    else text = bind(value.value);

    const type = value.kind === 'value' ? value.value.type : value.type.type;

    return raw ? text : dialect.operand(text, type, comparison);
  };
  const equality = (
    left: ResolvedOperand,
    right: ResolvedOperand,
    correlation: boolean,
  ): string => {
    const type = left.kind === 'value' ? left.value.type : left.type.type;

    return dialect.equality
      ? dialect.equality(
          operand(left, false, true),
          operand(right, false, true),
          type,
          correlation,
        )
      : `${operand(left, true)} ${dialect.operator('=')} ${operand(right, true)}`;
  };
  const predicate = (value: ResolvedPredicate): string => {
    if (value.kind === 'compare') {
      if (value.op === '=')
        return `(${equality(value.left, value.right, false)})`;

      return `(${operand(value.left, true)} ${dialect.operator(value.op)} ${operand(value.right, true)})`;
    }

    if (value.kind === 'null')
      return `(${operand(value.value)} IS ${value.not ? 'NOT ' : ''}NULL)`;

    if (value.op === 'not') {
      return `(NOT ${predicate(value.args[0]!)})`;
    }

    return `(${value.args.map(predicate).join(value.op === 'and' ? ' AND ' : ' OR ')})`;
  };

  const names = [
    'slot',
    ...query.keys.map((_, i) => `k${i}`),
    ...query.aggregates.map((_, i) => `m${i}`),
  ];
  const rows = slots.map((slot, index) => {
    return `(${[
      bind({ type: 'int32', value: index }),
      ...slot.values.map(bind),
      ...slot.valid.map((value) => bind({ type: 'boolean', value })),
    ].join(', ')})`;
  });
  const aggregates: string[] = [];
  const leaves = new Map<
    ResolvedAggregateLeaf,
    { readonly value: string; readonly failed: readonly string[] }
  >();
  const generated = (sql: string) => {
    const alias = `v${aggregates.length}`;

    aggregates.push(`${sql} AS ${alias}`);

    return `a.${alias}`;
  };
  const checked = dialect.checked;
  // Each node binds its children once, so SQL size stays linear in the expression.
  const row = (
    value: ResolvedRowExpression,
  ): { readonly sql: string; readonly type: CheckedType } =>
    foldRowExpression<
      ResolvedOperand,
      { readonly type: { readonly type: CheckedType } },
      { readonly sql: string; readonly type: CheckedType }
    >(
      value,
      (leaf) => {
        const type = leaf.kind === 'value' ? leaf.value.type : leaf.type.type;

        if (type !== 'int32' && type !== 'int64' && type !== 'float64')
          throw new Error('Invalid authorized analytical query');

        return {
          sql: checked.operand(operand(leaf), type),
          type: type === 'float64' ? 'float64' : 'int64',
        };
      },
      (node, left, right) => ({
        sql: `(SELECT ${checked.node(node.op, { sql: 'z.l', type: left.type }, { sql: 'z.r', type: right.type }, node.type.type)} FROM (SELECT ${left.sql} AS l, ${right.sql} AS r${checked.fence ?? ''}) AS z)`,
        type: node.type.type,
      }),
    );
  const collectLeaf = (
    aggregate: ResolvedAggregateLeaf,
    index: number,
  ): void => {
    const filter = `k.m${index}${
      aggregate.predicate ? ` AND ${predicate(aggregate.predicate)}` : ''
    }`;
    const argument = aggregate.argument;
    const plainType =
      argument === '*' || isRowArithmetic(argument)
        ? undefined
        : argument.kind === 'value'
          ? argument.value.type
          : argument.type.type;

    const arithmetic = argument !== '*' && isRowArithmetic(argument);

    // Float MIN/MAX are checked too, so a stored non-finite value fails one
    // cell rather than every object's value for the alias.
    if (
      arithmetic ||
      ((aggregate.aggregate === 'sum' || aggregate.aggregate === 'avg') &&
        (plainType === 'int32' ||
          plainType === 'int64' ||
          plainType === 'float64')) ||
      ((aggregate.aggregate === 'min' || aggregate.aggregate === 'max') &&
        plainType === 'float64')
    ) {
      const input: CheckedInput = arithmetic
        ? { ...row(argument), placeholder: true, bound: true }
        : {
            sql: checked.operand(
              operand(argument as ResolvedOperand),
              plainType as 'int32' | 'int64' | 'float64',
            ),
            type: plainType === 'float64' ? 'float64' : 'int64',
            // Non-finite source floats must not disappear during accumulation.
            placeholder: plainType === 'float64',
            bound: false,
          };
      // A failed row is a placeholder in the accumulation and a set flag here.
      const flag = input.placeholder
        ? generated(checked.flag(checked.failed(input.sql, input.type), filter))
        : undefined;
      const accumulation = checked.accumulate(
        aggregate.aggregate,
        input,
        filter,
      );
      const columns = accumulation.columns.map(generated);

      leaves.set(aggregate, {
        value: accumulation.value(columns),
        failed: [
          ...(flag ? [`COALESCE(${flag}, 0) ${dialect.operator('=')} 1`] : []),
          ...(accumulation.failed ? [accumulation.failed(columns)] : []),
        ],
      });

      return;
    }

    leaves.set(aggregate, {
      value: generated(
        dialect.aggregate(
          aggregate,
          argument === '*'
            ? '*'
            : operand(
                argument,
                ['min', 'max'].includes(aggregate.aggregate) ||
                  aggregate.distinct,
              ),
          filter,
        ),
      ),
      failed: [],
    });
  };

  // Render all aggregate inputs before projection values for positional binds.
  query.aggregates.forEach((value, index) =>
    value.aggregate === 'expression'
      ? scalarLeaves(value.expression).forEach(
          (leaf) => leaf.kind === 'aggregate' && collectLeaf(leaf.value, index),
        )
      : collectLeaf(value, index),
  );
  const leafProjection = (aggregate: ResolvedAggregateLeaf): string => {
    let value = leaves.get(aggregate)!.value;

    if (aggregate.aggregate === 'count')
      value = `COALESCE(${value}, ${bind({ type: 'int64', value: 0n })})`;
    else if (aggregate.fallback)
      value = `COALESCE(${value}, ${bind(aggregate.fallback)})`;

    if (aggregate.result.type === 'timestamp')
      value = dialect.timestamp(value, aggregate.result.precision, bind);
    else if (aggregate.result.type === 'date')
      value = dialect.date(value, bind);

    return value;
  };
  const float = (sql: string) => `CAST(${sql} AS DOUBLE PRECISION)`;
  const nullif = (left: string, right: string) =>
    dialect.nullif ? dialect.nullif(left, right) : `NULLIF(${left}, ${right})`;
  const scalar = (value: ResolvedScalarExpression): string =>
    foldScalarExpression(
      value,
      (leaf) =>
        float(
          leaf.kind === 'aggregate'
            ? leafProjection(leaf.value)
            : operand(leaf.value),
        ),
      (node, left, right) => {
        if (node.kind === 'binary') {
          // Guard every denominator: all supported engines return NULL for zero division.
          return `(${left} ${dialect.operator(node.op)} ${node.op === '/' ? nullif(right, float('0')) : right})`;
        }

        return node.kind === 'nullif'
          ? nullif(left, right)
          : `COALESCE(${left}, ${right})`;
      },
    );
  const projection = query.aggregates.map(
    (aggregate, index) =>
      `${aggregate.aggregate === 'expression' ? scalar(aggregate.expression) : leafProjection(aggregate)} AS v${index}`,
  );
  // One check per output: any failed row or accumulation in any of its leaves.
  const checks = query.aggregates.map((aggregate, index) => {
    const failed = (
      aggregate.aggregate === 'expression'
        ? scalarLeaves(aggregate.expression).flatMap((leaf) =>
            leaf.kind === 'aggregate' ? leaves.get(leaf.value)!.failed : [],
          )
        : leaves.get(aggregate)!.failed
    ).map((term) => `(${term})`);

    return `${failed.length ? `CASE WHEN ${failed.join(' OR ')} THEN 1 ELSE 0 END` : '0'} AS c${index}`;
  });
  const correlation = query.correlation
    .map((pair) => {
      const type = query.keys[pair.key]!.type;

      return equality(
        { kind: 'column', column: pair.column, type },
        { kind: 'key', key: pair.key, type },
        true,
      );
    })
    .join(' AND ');

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
      )} AS d ON ${correlation} GROUP BY k.slot) SELECT k.slot, ${[...projection, ...checks].join(', ')} FROM keys AS k LEFT JOIN agg AS a ON a.slot ${dialect.operator('=')} k.slot ORDER BY k.slot`,
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

export type CheckedType = 'int64' | 'float64';

/** One aggregate input row value in the dialect's checked representation. */
export interface CheckedInput {
  readonly sql: string;
  readonly type: CheckedType;
  /** True when the value may be a failure placeholder or non-finite input. */
  readonly placeholder: boolean;
  /** True when the SQL is too costly to repeat, so it is bound once per row. */
  readonly bound: boolean;
}

/**
 * Transform an input row value with failures treated as null. Row arithmetic
 * is bound once in a subquery; a plain operand is repeated inline.
 */
export function checkedValue(
  input: CheckedInput,
  failed: CheckedArithmeticDialect['failed'],
  body: (value: string) => string,
): string {
  if (!input.placeholder) return body(input.sql);

  if (!input.bound)
    return `CASE WHEN ${failed(input.sql, input.type)} THEN NULL ELSE ${body(input.sql)} END`;

  return `(SELECT CASE WHEN ${failed('s.v', input.type)} THEN NULL ELSE ${body('s.v')} END FROM (SELECT ${input.sql} AS v) AS s)`;
}

/** Final value and failure test over the aliased aggregate columns. */
export interface CheckedAccumulation {
  /** Aggregate expressions, each already restricted by the given filter. */
  readonly columns: readonly string[];
  value(columns: readonly string[]): string;
  /** Boolean SQL; true when accumulation or final conversion left the range. */
  readonly failed?: (columns: readonly string[]) => string;
}

/**
 * Checked row arithmetic. A failed node yields an in-band placeholder that no
 * valid value of its type can take; nodes propagate child placeholders before
 * nulls, so a failure survives later operations and cancellation.
 */
export interface CheckedArithmeticDialect {
  /** A numeric operand in the dialect's checked representation for its type. */
  operand(sql: string, type: 'int32' | 'int64' | 'float64'): string;
  /** One node over bound child columns, each safe to reference repeatedly. */
  node(
    op: ArithmeticOperator,
    left: { readonly sql: string; readonly type: CheckedType },
    right: { readonly sql: string; readonly type: CheckedType },
    result: CheckedType,
  ): string;
  /** Boolean SQL for failure placeholders or non-finite inputs (null for null). */
  failed(sql: string, type: CheckedType): string;
  /** An aggregate yielding 1 when the condition held on any filtered row. */
  flag(condition: string, filter: string): string;
  /** Checked accumulation; placeholders count as null (see `checkedValue`). */
  accumulate(
    aggregate: Aggregate,
    input: CheckedInput,
    filter: string,
  ): CheckedAccumulation;
  /** Appended to each node's child binding, such as a planning fence. */
  readonly fence?: string;
}

/** Dialect-owned syntax; authorization, validation and relational shape stay shared. */
export interface AnalyticalSqlDialect<
  Value extends AnalyticalScalar | bigint = AnalyticalScalar | bigint,
> {
  bind(value: TypedValue, position: number): { sql: string; value: Value };
  operand(sql: string, type: LogicalType['type'], comparison: boolean): string;
  /** Raw operands are bound once; hooks may reuse numbered binds or correlation keys. */
  equality?(
    left: string,
    right: string,
    type: LogicalType['type'],
    correlation: boolean,
  ): string;
  operator(operator: string): string;
  /** Replaces `NULLIF`; must render each argument exactly once. */
  nullif?(left: string, right: string): string;
  aggregate(
    aggregate: ResolvedAggregateLeaf,
    argument: string,
    filter: string,
  ): string;
  timestamp(
    sql: string,
    precision: 3 | 6,
    bind: (value: TypedValue) => string,
  ): string;
  readonly timestampParameters: number;
  /** Render a date result as canonical `YYYY-MM-DD` text. */
  date(sql: string, bind: (value: TypedValue) => string): string;
  readonly dateParameters: number;
  readonly checked: CheckedArithmeticDialect;
}

/** Count bound values without rendering SQL or encoding scalar values. */
export function analyticalParameterBudget(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  dialect: Pick<AnalyticalSqlDialect, 'timestampParameters' | 'dateParameters'>,
): { fixed: number; perSlot: number } {
  const operand = (value: ResolvedOperand): number =>
    value.kind === 'value' ? 1 : 0;
  const predicate = (value: ResolvedPredicate): number => {
    if (value.kind === 'compare')
      return operand(value.left) + operand(value.right);

    if (value.kind === 'null') return operand(value.value);

    return value.args.reduce((sum, arg) => sum + predicate(arg), 0);
  };
  const aggregate = (value: ResolvedAggregate): number =>
    value.aggregate === 'expression'
      ? foldScalarExpression(
          value.expression,
          (leaf) =>
            leaf.kind === 'aggregate'
              ? aggregate(leaf.value)
              : operand(leaf.value),
          (_, left, right) => left + right,
        )
      : (value.argument === '*'
          ? 0
          : foldRowExpression<
              ResolvedOperand,
              { readonly type: { readonly type: CheckedType } },
              number
            >(value.argument, operand, (_, left, right) => left + right)) +
        (value.predicate ? predicate(value.predicate) : 0) +
        (value.aggregate === 'count' || value.fallback ? 1 : 0) +
        (value.result.type === 'timestamp'
          ? dialect.timestampParameters
          : value.result.type === 'date'
            ? dialect.dateParameters
            : 0);
  const fixed = query.aggregates.reduce(
    (sum, value) => sum + aggregate(value),
    0,
  );

  return { fixed, perSlot: 1 + query.keys.length + query.aggregates.length };
}
