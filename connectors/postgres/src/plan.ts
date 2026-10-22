import { encodeAnalyticalValue } from 'relate/analytics';
import type {
  AuthorizedDatasetQuery,
  ResolvedOperand,
  ResolvedPredicate,
  TypedValue,
} from 'relate/connectors';
import { identifier } from './identifiers.js';

export interface SelectedDataset {
  readonly table: string;
  readonly schema: string;
  readonly columns: Readonly<Record<string, string>>;
}

export interface PostgresPlan {
  readonly sql: string;
  readonly values: readonly (string | number | boolean | null)[];
  readonly slots: number;
  readonly results: readonly AuthorizedDatasetQuery['aggregates'][number]['result'][];
}

function invalid(): never {
  throw new Error('Invalid authorized analytical query');
}

/** Only connector-produced identifiers, fixed syntax, and explicitly typed bound values. */
export function render(
  query: Omit<AuthorizedDatasetQuery, 'slots'>,
  resource: SelectedDataset,
  slots: AuthorizedDatasetQuery['slots'],
): PostgresPlan {
  const values: (string | number | boolean | null)[] = [];
  const bind = (value: TypedValue): string => {
    const encoded = encodeAnalyticalValue(value.value, {
      ...value,
      nullable: true,
    });

    // ISO year zero is PostgreSQL 1 BC; retain the same instant and precision.
    values.push(
      value.type === 'timestamp' &&
        typeof encoded === 'string' &&
        encoded.startsWith('0000-')
        ? `0001-${encoded.slice(5)} BC`
        : encoded,
    );
    const sqlType = {
      string: 'pg_catalog.text',
      boolean: 'pg_catalog.bool',
      int32: 'pg_catalog.int4',
      int64: 'pg_catalog.int8',
      float64: 'pg_catalog.float8',
      timestamp: 'pg_catalog.timestamptz',
    }[value.type];

    return `$${values.length}::${sqlType}`;
  };
  const column = (name: string) => {
    if (!Object.hasOwn(resource.columns, name)) invalid();

    return `d.${identifier(resource.columns[name]!)}`;
  };
  const operand = (value: ResolvedOperand, ordered = true): string => {
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

    return type === 'string' && ordered
      ? `(${text} COLLATE pg_catalog."C")`
      : text;
  };
  const equality = (left: ResolvedOperand, right: ResolvedOperand): string => {
    const a = operand(left, false),
      b = operand(right, false);
    const type = left.kind === 'value' ? left.value.type : left.type.type;
    const indexed = `${a} OPERATOR(pg_catalog.=) ${b}`;

    // The ordinary equality is indexable. The binary guard preserves exact scope
    // under nondeterministic collations, including a schema change after startup.
    return type === 'string'
      ? `(${indexed} AND (${a} COLLATE pg_catalog."C") OPERATOR(pg_catalog.=) (${b} COLLATE pg_catalog."C"))`
      : `(${indexed})`;
  };
  const predicate = (value: ResolvedPredicate): string => {
    if (value.kind === 'compare') {
      if (!['=', '<>', '<', '<=', '>', '>='].includes(value.op)) invalid();

      if (value.op === '=') return equality(value.left, value.right);

      return `(${operand(value.left)} OPERATOR(pg_catalog.${value.op}) ${operand(value.right)})`;
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
    let sql = `pg_catalog.${name}(${aggregate.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE k.m${index}${filter})`;

    // PostgreSQL promotes bigint SUM and integer AVG to numeric; preserve the portable contract.
    if (aggregate.aggregate === 'sum' && aggregate.result.type === 'int64')
      sql = `CAST(${sql} AS pg_catalog.int8)`;

    if (aggregate.aggregate === 'avg')
      sql = `CAST(${sql} AS pg_catalog.float8)`;

    return `${sql} AS v${index}`;
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

      return equality(
        { kind: 'column', column: pair.column, type },
        { kind: 'key', key: pair.key, type },
      );
    })
    .join(' AND ');
  const projection = query.aggregates.map((aggregate, i) => {
    let value = `a.v${i}`;

    if (aggregate.aggregate === 'count')
      value = `COALESCE(${value}, ${bind({ type: 'int64', value: 0n })})`;
    else if (aggregate.fallback)
      value = `COALESCE(${value}, ${bind(aggregate.fallback)})`;

    if (aggregate.result.type === 'timestamp') {
      const fraction = aggregate.result.precision === 3 ? 'MS' : 'US';

      const invalid = bind({ type: 'string', value: 'infinity' });
      const zone = bind({ type: 'string', value: 'UTC' });
      const format = bind({
        type: 'string',
        value: `YYYY-MM-DD"T"HH24:MI:SS.${fraction}"Z"AD`,
      });

      value = `CASE WHEN NOT pg_catalog.isfinite(${value}) THEN ${invalid} ELSE pg_catalog.to_char(${value} AT TIME ZONE ${zone}, ${format}) END`;
    }

    return `${value} AS v${i}`;
  });

  // Positional parameters are explicitly typed; physical identifiers stay connector-owned.
  return {
    sql: `WITH keys(${names.join(', ')}) AS (VALUES ${rows.join(', ')}), agg AS (SELECT k.slot, ${aggregates.join(', ')} FROM keys AS k JOIN ${identifier(resource.schema)}.${identifier(resource.table)} AS d ON ${correlation} GROUP BY k.slot) SELECT k.slot, ${projection.join(', ')} FROM keys AS k LEFT JOIN agg AS a ON a.slot OPERATOR(pg_catalog.=) k.slot ORDER BY k.slot`,
    values,
    slots: slots.length,
    results: query.aggregates.map((aggregate) => ({ ...aggregate.result })),
  };
}
