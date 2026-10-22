import { encodeAnalyticalValue } from 'relate/analytics';
import type {
  AuthorizedDatasetQuery,
  ResolvedOperand,
  ResolvedPredicate,
  TypedValue,
} from 'relate/connectors';
import { identifier } from '../contracts.js';

export interface SelectedDataset {
  readonly table: string;
  readonly columns: Readonly<Record<string, string>>;
}

export interface SqlitePlan {
  readonly sql: string;
  readonly values: readonly (string | number | bigint | null)[];
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
): SqlitePlan {
  const values: (string | number | bigint | null)[] = [];
  const bind = (value: TypedValue): string => {
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

    values.push(converted);
    const sqlType =
      value.type === 'string' || value.type === 'timestamp'
        ? 'TEXT'
        : value.type === 'float64'
          ? 'REAL'
          : 'INTEGER';

    return `CAST(? AS ${sqlType})`;
  };
  const column = (name: string) => {
    if (!Object.hasOwn(resource.columns, name)) invalid();

    return `d.${identifier(resource.columns[name]!)}`;
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

    if (comparison && type === 'timestamp') text = `__relate_instant(${text})`;

    return type === 'string' || type === 'timestamp'
      ? `(${text} COLLATE BINARY)`
      : text;
  };
  const predicate = (value: ResolvedPredicate): string => {
    if (value.kind === 'compare') {
      if (!['=', '<>', '<', '<=', '>', '>='].includes(value.op)) invalid();

      return `(${operand(value.left, true)} ${value.op} ${operand(value.right, true)})`;
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
      aggregate.argument === '*'
        ? '*'
        : operand(
            aggregate.argument,
            ['min', 'max'].includes(aggregate.aggregate),
          );
    const filter = aggregate.predicate
      ? ` AND ${predicate(aggregate.predicate)}`
      : '';

    return `${aggregate.aggregate.toUpperCase()}(${aggregate.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE k.m${index}${filter}) AS v${index}`;
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

      const left = operand({ kind: 'column', column: pair.column, type });
      const right = operand({ kind: 'key', key: pair.key, type });

      if (type.type === 'timestamp') {
        const exact = `__relate_instant(${right})`;
        const millis = `CASE WHEN substr(${exact}, 24, 3) = '000' THEN substr(${exact}, 1, 23) || 'Z' ELSE ${exact} END`;

        return `(${left} IN (${exact}, ${millis}))`;
      }

      return `${left} = ${right}`;
    })
    .join(' AND ');
  const projection = query.aggregates.map((aggregate, i) => {
    let value = `a.v${i}`;

    if (aggregate.aggregate === 'count')
      value = `COALESCE(${value}, ${bind({ type: 'int64', value: 0n })})`;
    else if (aggregate.fallback)
      value = `COALESCE(${value}, ${bind(aggregate.fallback)})`;

    return `${value} AS v${i}`;
  });

  // Projection placeholders occur after the aggregate CTE, matching the bind order.
  return {
    sql: `WITH keys(${names.join(', ')}) AS (VALUES ${rows.join(', ')}), agg AS (SELECT k.slot, ${aggregates.join(', ')} FROM keys AS k JOIN ${identifier(resource.table)} AS d ON ${correlation} GROUP BY k.slot) SELECT k.slot, ${projection.join(', ')} FROM keys AS k LEFT JOIN agg AS a ON a.slot = k.slot ORDER BY k.slot`,
    values,
    slots: slots.length,
    results: query.aggregates.map((aggregate) => ({ ...aggregate.result })),
  };
}
