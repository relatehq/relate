import { checkedValue } from 'relate/analytics';
import type {
  CheckedAccumulation,
  CheckedArithmeticDialect,
  CheckedInput,
  CheckedType,
} from 'relate/analytics';

// PostgreSQL raises on float overflow and on a nonzero product or quotient that
// rounds to zero. Every float operation is classified exactly before it runs.

const op = (name: string, left: string, right: string) =>
  `(${left} OPERATOR(pg_catalog.${name}) ${right})`;
const float = (value: number) => `'${String(value)}'::pg_catalog.float8`;
const numeric = (value: string) => `'${value}'::pg_catalog.numeric`;
const abs = (value: string) => `pg_catalog.abs(${value})`;
const floatNaN = `'NaN'::pg_catalog.float8`;
const numericNaN = `'NaN'::pg_catalog.numeric`;
const max = float(Number.MAX_VALUE);
const big = float(2 ** 512);
const small = float(2 ** -512);
const int64Min = numeric('-9223372036854775808');
const int64Max = numeric('9223372036854775807');

const inInt64 = (value: string) =>
  `(${op('>=', value, int64Min)} AND ${op('<=', value, int64Max)})`;
const toFloat = (value: string) => `CAST(${value} AS pg_catalog.float8)`;
const failed = (value: string, type: CheckedType) =>
  op('=', value, type === 'float64' ? floatNaN : numericNaN);

/** Byte `i` of an 8-byte big-endian float8send value. */
const byte = (bytes: string, i: number) =>
  `CAST(pg_catalog.get_byte(${bytes}, ${i}) AS pg_catalog.int8)`;

/** Exact significand `M` and exponent `E` with `|x| = M * 2^E`. */
function decode(bytes: string): { m: string; e: string } {
  const biased = op(
    '/',
    op('%', op('+', op('*', byte(bytes, 0), '256'), byte(bytes, 1)), '32768'),
    '16',
  );
  const fraction = [
    op('*', op('%', byte(bytes, 1), '16'), '281474976710656'),
    ...[2, 3, 4, 5, 6, 7].map((i) =>
      op('*', byte(bytes, i), String(2n ** BigInt(8 * (7 - i)))),
    ),
  ].reduce((sum, part) => op('+', sum, part));

  return {
    m: op(
      '+',
      `CAST(CASE WHEN ${op('=', biased, '0')} THEN 0 ELSE 4503599627370496 END AS pg_catalog.numeric)`,
      `CAST(${fraction} AS pg_catalog.numeric)`,
    ),
    e: `CASE WHEN ${op('=', biased, '0')} THEN -1074 ELSE ${op('-', biased, '1075')} END`,
  };
}

/** Sign of `a * 2^n - b`, for integers `1 <= a, b < 2^107`. */
function compare(a: string, n: string, b: string): string {
  const power = (exponent: string) =>
    `pg_catalog.power(CAST(2 AS pg_catalog.numeric), CAST(${exponent} AS pg_catalog.numeric))`;

  return `(SELECT CASE WHEN ${op('>=', 'w.n', '108')} THEN 1 WHEN ${op('<=', 'w.n', '-108')} THEN -1 WHEN ${op('>=', 'w.n', '0')} THEN pg_catalog.sign(${op('-', op('*', 'w.a', power('w.n')), 'w.b')}) ELSE pg_catalog.sign(${op('-', 'w.a', op('*', 'w.b', power(op('-', '0', 'w.n'))))}) END FROM (SELECT ${a} AS a, ${n} AS n, ${b} AS b) AS w)`;
}

/** Binary64 overflows at or above the halfway point past the largest finite value. */
const overflowBound = '18014398509481983'; // (2^54 - 1), scaled by 2^970

/** True when `x ± y` overflows; never evaluates a float operation that can raise. */
function additionOverflows(x: string, y: string, subtract: boolean): string {
  // Halving is exact for magnitudes of at least 1; smaller ones become zero.
  const half = (value: string) =>
    op(
      '*',
      `CASE WHEN ${op('>=', abs(value), float(1))} THEN ${value} ELSE ${float(0)} END`,
      float(0.5),
    );
  const sum = op(subtract ? '-' : '+', half(x), half(y));

  return `(CASE WHEN ${op('<', abs(x), float(2 ** 1022))} AND ${op('<', abs(y), float(2 ** 1022))} THEN false WHEN ${op('<', abs(x), float(1))} OR ${op('<', abs(y), float(1))} THEN false ELSE ${op('>=', abs(sum), float(2 ** 1023))} END)`;
}

/** Checked float operation over finite, non-null operands `x` and `y`. */
function floatOperation(operator: string, x: string, y: string): string {
  if (operator === '+' || operator === '-')
    return `CASE WHEN ${additionOverflows(x, y, operator === '-')} THEN ${floatNaN} ELSE ${op(operator, x, y)} END`;

  const left = decode('b.bl'),
    right = decode('b.br');
  const exponent = (sign: '+' | '-', shift: string) =>
    op('+', op(sign, 'd.el', 'd.er'), shift);
  const [overflow, zero] =
    operator === '*'
      ? [
          compare(
            op('*', 'd.ml', 'd.mr'),
            exponent('+', '-970'),
            overflowBound,
          ),
          compare(op('*', 'd.ml', 'd.mr'), exponent('+', '1075'), '1'),
        ]
      : [
          compare(
            'd.ml',
            exponent('-', '-970'),
            op('*', overflowBound, 'd.mr'),
          ),
          compare('d.ml', exponent('-', '1075'), 'd.mr'),
        ];
  const zeroInput =
    operator === '*'
      ? `${op('=', x, float(0))} OR ${op('=', y, float(0))}`
      : op('=', x, float(0));
  const zeroDenominator =
    operator === '/' ? `WHEN ${op('=', y, float(0))} THEN ${floatNaN} ` : '';
  // Magnitudes in [2^-500, 2^500] keep any product or quotient normal.
  const moderate = [x, y]
    .map(
      (value) =>
        `${op('>=', abs(value), float(2 ** -500))} AND ${op('<=', abs(value), float(2 ** 500))}`,
    )
    .join(' AND ');
  // CASE evaluates the exact classification only outside the moderate range.
  const exact = `(SELECT CASE WHEN ${op('>=', overflow, '0')} THEN ${floatNaN} WHEN ${op('<=', zero, '0')} THEN ${float(0)} ELSE ${op(operator, 'd.x', 'd.y')} END FROM (SELECT b.x, b.y, ${left.m} AS ml, ${left.e} AS el, ${right.m} AS mr, ${right.e} AS er FROM (SELECT ${x} AS x, ${y} AS y, pg_catalog.float8send(${x}) AS bl, pg_catalog.float8send(${y}) AS br) AS b) AS d)`;

  return `CASE ${zeroDenominator}WHEN ${zeroInput} THEN ${float(0)} WHEN ${moderate} THEN ${op(operator, x, y)} ELSE ${exact} END`;
}

/** Checked `hi * 2^512 + lo` for the two float partial sums. */
function recombine(hi: string, lo: string): { value: string; failed: string } {
  const scaled = `CASE WHEN ${op('<', abs(hi), big)} THEN ${op('*', hi, big)} ELSE ${float(0)} END`;
  const failed = `(${op('>=', abs(hi), big)} OR ${additionOverflows(scaled, lo, false)})`;

  return {
    value: `CASE WHEN ${failed} THEN NULL ELSE ${op('+', scaled, lo)} END`,
    failed,
  };
}

function floatAccumulation(
  average: boolean,
  input: CheckedInput,
  filter: string,
): CheckedAccumulation {
  const bucket = (large: boolean) =>
    `pg_catalog.sum(${checkedValue(input, failed, (v) => `CASE WHEN ${op(large ? '>=' : '<', abs(v), big)} THEN ${large ? op('*', v, small) : v} END`)}) FILTER (WHERE ${filter})`;
  const columns = [bucket(true), bucket(false)];

  if (average)
    columns.push(
      `pg_catalog.count(${checkedValue(input, failed, (v) => v)}) FILTER (WHERE ${filter})`,
    );

  const parts = (refs: readonly string[]) => {
    const [hi, lo, count] = [
      `COALESCE(${refs[0]}, ${float(0)})`,
      `COALESCE(${refs[1]}, ${float(0)})`,
      toFloat(refs[2] ?? '1'),
    ];

    // Dividing the scaled part keeps it normal; the small part may round to zero.
    return average
      ? recombine(
          op('/', hi, count),
          `(SELECT ${floatOperation('/', 'q.lo', 'q.n')} FROM (SELECT ${lo} AS lo, ${count} AS n OFFSET 0) AS q)`,
        )
      : recombine(hi, lo);
  };
  const empty = (refs: readonly string[]) =>
    `${refs[0]} IS NULL AND ${refs[1]} IS NULL`;

  return {
    columns,
    value: (refs) =>
      `CASE WHEN ${empty(refs)} THEN NULL ELSE ${parts(refs).value} END`,
    // CASE keeps an empty aggregate's zero count out of the division.
    failed: (refs) =>
      `(CASE WHEN ${empty(refs)} THEN false ELSE ${parts(refs).failed} END)`,
  };
}

export const checked: CheckedArithmeticDialect = {
  operand(sql, type) {
    return type === 'float64' ? sql : `CAST(${sql} AS pg_catalog.numeric)`;
  },
  node(operator, left, right, result) {
    const childFailed = `${failed(left.sql, left.type)} OR ${failed(right.sql, right.type)}`;
    const nulls = `${left.sql} IS NULL OR ${right.sql} IS NULL`;

    if (result === 'int64') {
      const value = op(operator, left.sql, right.sql);

      return `CASE WHEN ${childFailed} THEN ${numericNaN} WHEN ${nulls} THEN NULL WHEN ${inInt64(value)} THEN ${value} ELSE ${numericNaN} END`;
    }

    const x = left.type === 'float64' ? left.sql : toFloat(left.sql);
    const y = right.type === 'float64' ? right.sql : toFloat(right.sql);
    // NaN placeholders and infinite inputs both fail this finite test.
    const finite = (value: string) => op('<=', abs(value), max);

    return `CASE WHEN NOT ${finite(x)} OR NOT ${finite(y)} THEN ${floatNaN} WHEN ${nulls} THEN NULL ELSE ${floatOperation(operator, x, y)} END`;
  },
  // Keeps constant operands from being folded into a native operation at plan
  // time, where an out-of-range result would raise before any guard runs.
  fence: ' OFFSET 0',
  failed,
  flag(condition, filter) {
    return `pg_catalog.max(CASE WHEN ${condition} THEN 1 ELSE 0 END) FILTER (WHERE ${filter})`;
  },
  accumulate(aggregate, input, filter) {
    const type = input.type;
    const call = (name: string) =>
      `pg_catalog.${name}(${checkedValue(input, failed, (v) => v)}) FILTER (WHERE ${filter})`;

    if (aggregate === 'count')
      return { columns: [call('count')], value: ([v]) => v! };

    if (aggregate === 'min' || aggregate === 'max')
      return {
        columns: [call(aggregate)],
        value: ([v]) =>
          type === 'int64' ? `CAST(${v} AS pg_catalog.int8)` : v!,
      };

    if (type === 'float64')
      return floatAccumulation(aggregate === 'avg', input, filter);

    if (aggregate === 'avg')
      return { columns: [call('avg')], value: ([v]) => toFloat(v!) };

    // Numeric sums are exact; only the final total must fit int64.
    return {
      columns: [call('sum')],
      value: ([v]) =>
        `CASE WHEN ${inInt64(v!)} THEN CAST(${v} AS pg_catalog.int8) END`,
      failed: ([v]) => `NOT ${inInt64(v!)}`,
    };
  },
};
