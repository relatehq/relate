import { propertyColumnTypes } from './model.js';
import type { PropertyColumn, PropertyRow } from './model.js';
import type { Operand, Predicate, PropertyQuery, Scalar } from './query.js';

type Value = Scalar | null;

type Truth = boolean | null;

/** Microseconds since the epoch, for any ISO spelling of an instant. */
function instant(text: string): bigint {
  const match =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(
      text,
    );

  if (!match) throw new Error(`Not an instant: ${text}`);

  return (
    BigInt(Date.parse(`${match[1]}${match[3]}`)) * 1000n +
    BigInt((match[2] ?? '').padEnd(6, '0'))
  );
}

function canonical(micros: bigint): string {
  const seconds = new Date(Number(micros / 1_000_000n) * 1000).toISOString();

  return `${seconds.slice(0, 19)}.${String(micros % 1_000_000n).padStart(6, '0')}Z`;
}

/** SQL ordering: strings by UTF-8 bytes (PostgreSQL "C", SQLite BINARY), timestamps by instant. */
function order(type: string, left: Scalar, right: Scalar): number {
  if (type === 'string')
    return Buffer.compare(
      Buffer.from(left as string),
      Buffer.from(right as string),
    );

  if (type === 'timestamp') {
    const a = instant(left as string),
      b = instant(right as string);

    return a < b ? -1 : a > b ? 1 : 0;
  }

  if (type === 'boolean') return Number(left) - Number(right);

  return left < right ? -1 : left > right ? 1 : 0;
}

function typeOf(left: Operand, right: Operand): string {
  for (const side of [left, right]) {
    if (side.kind === 'column') return propertyColumnTypes[side.column];

    if (side.kind === 'since') return 'timestamp';
  }

  throw new Error('A generated comparison always names a column');
}

/** SQL three-valued logic: NULL is neither true nor false. */
function truth(predicate: Predicate, row: PropertyRow, since: string): Truth {
  if (predicate.kind === 'null') {
    const missing = row[predicate.column] === null;

    return predicate.not ? !missing : missing;
  }

  if (predicate.kind === 'not') {
    const value = truth(predicate.arg, row, since);

    return value === null ? null : !value;
  }

  if (predicate.kind === 'boolean') {
    const values = predicate.args.map((arg) => truth(arg, row, since));
    const decisive = predicate.op === 'and' ? false : true;

    if (values.includes(decisive)) return decisive;

    return values.includes(null) ? null : !decisive;
  }

  const operand = (value: Operand): Value =>
    value.kind === 'column'
      ? row[value.column]
      : value.kind === 'since'
        ? since
        : value.value;
  const left = operand(predicate.left),
    right = operand(predicate.right);

  if (left === null || right === null) return null;

  const result = order(typeOf(predicate.left, predicate.right), left, right);

  switch (predicate.op) {
    case '=':
      return result === 0;
    case '<>':
    case '!=':
      return result !== 0;
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
  }
}

/** The JSON value a consumer receives for one result. */
function encode(type: string, value: Scalar): unknown {
  if (type === 'int64') return String(value);

  if (type === 'timestamp') return canonical(instant(value as string));

  return value;
}

/** Expected consumer value for one customer, computed from the rules alone. */
export function referenceValue(
  query: PropertyQuery,
  rows: readonly PropertyRow[],
  customer: { readonly external: string; readonly since: string },
): unknown {
  const matching = rows.filter(
    (row) =>
      row.customerId === customer.external &&
      (!query.predicate ||
        truth(query.predicate, row, customer.since) === true),
  );

  if (query.argument === '*') return String(matching.length);

  const column: PropertyColumn = query.argument;
  const type = propertyColumnTypes[column];
  const values = matching
    .map((row) => row[column])
    .filter((value): value is Scalar => value !== null);

  if (query.aggregate === 'count') {
    if (!query.distinct) return String(values.length);

    const keys = new Set(
      values.map((value) =>
        type === 'timestamp' ? String(instant(value as string)) : String(value),
      ),
    );

    return String(keys.size);
  }

  if (!values.length) return null;

  if (query.aggregate === 'sum' || query.aggregate === 'avg') {
    if (type === 'float64') {
      const sum = (values as number[]).reduce((a, b) => a + b, 0);

      return query.aggregate === 'sum' ? sum : sum / values.length;
    }

    const sum = values.reduce<bigint>((a, b) => a + BigInt(b as number), 0n);

    return query.aggregate === 'sum'
      ? String(sum)
      : Number(sum) / values.length;
  }

  const sorted = [...values].sort((a, b) => order(type, a, b));

  return encode(
    type,
    query.aggregate === 'min' ? sorted[0]! : sorted[sorted.length - 1]!,
  );
}

/**
 * AVG and float64 SUM are backend arithmetic (documented to differ in the last
 * digits); every other result must match exactly.
 */
export function approximate(query: PropertyQuery): boolean {
  return (
    query.aggregate === 'avg' ||
    (query.aggregate === 'sum' &&
      query.argument !== '*' &&
      propertyColumnTypes[query.argument] === 'float64')
  );
}
