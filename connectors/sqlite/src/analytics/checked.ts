import { checkedValue } from 'relate/analytics';
import type {
  CheckedAccumulation,
  CheckedArithmeticDialect,
  CheckedInput,
} from 'relate/analytics';

// SQLite turns integer overflow into REAL and float overflow into infinity
// without raising, so results are checked after native evaluation. Its native
// integer SUM raises on temporary overflow and is never used.

const real = (value: number) => String(value);
const placeholder = `'!'`;
const max = real(Number.MAX_VALUE);
const big = real(2 ** 512);
const small = real(2 ** -512);
const failed = (value: string) => `typeof(${value}) = 'text'`;
const finite = (value: string) => `abs(${value}) <= ${max}`;

function floatAccumulation(
  average: boolean,
  input: CheckedInput,
  filter: string,
): CheckedAccumulation {
  const bucket = (large: boolean) =>
    `SUM(${checkedValue(input, failed, (v) => `CASE WHEN abs(${v}) ${large ? '>=' : '<'} ${big} THEN ${large ? `${v} * ${small}` : v} END`)}) FILTER (WHERE ${filter})`;
  const columns = [bucket(true), bucket(false)];

  if (average)
    columns.push(
      `COUNT(${checkedValue(input, failed, (v) => v)}) FILTER (WHERE ${filter})`,
    );

  const total = ([hi, lo, count]: readonly string[]) => {
    const n = count ? `CAST(${count} AS REAL)` : '1.0';

    return `(COALESCE(${hi}, 0.0) / ${n}) * ${big} + COALESCE(${lo}, 0.0) / ${n}`;
  };
  const empty = ([hi, lo]: readonly string[]) =>
    `${hi} IS NULL AND ${lo} IS NULL`;

  return {
    columns,
    value: (refs) =>
      `CASE WHEN ${empty(refs)} OR NOT ${finite(total(refs))} THEN NULL ELSE ${total(refs)} END`,
    failed: (refs) => `(NOT (${empty(refs)}) AND NOT ${finite(total(refs))})`,
  };
}

/** Exact int64 SUM from 32-bit high and low partial sums, which cannot overflow. */
function integerSum(input: CheckedInput, filter: string): CheckedAccumulation {
  const carried = ([hi, lo]: readonly string[]) => `(${hi} + (${lo} >> 32))`;
  const fits = (refs: readonly string[]) =>
    `${carried(refs)} BETWEEN -2147483648 AND 2147483647`;

  return {
    columns: [
      `SUM(${checkedValue(input, failed, (v) => `${v} >> 32`)}) FILTER (WHERE ${filter})`,
      `SUM(${checkedValue(input, failed, (v) => `${v} & 4294967295`)}) FILTER (WHERE ${filter})`,
    ],
    value: (refs) =>
      `CASE WHEN ${fits(refs)} THEN (${carried(refs)} << 32) + (${refs[1]} & 4294967295) END`,
    failed: (refs) => `NOT (${fits(refs)})`,
  };
}

export const checked: CheckedArithmeticDialect = {
  operand(sql) {
    return sql;
  },
  node(operator, left, right, result) {
    const childFailed = `${failed(left.sql)} OR ${failed(right.sql)}`;
    const nulls = `${left.sql} IS NULL OR ${right.sql} IS NULL`;

    if (result === 'int64') {
      const value = `(${left.sql} ${operator} ${right.sql})`;

      return `CASE WHEN ${childFailed} THEN ${placeholder} WHEN ${nulls} THEN NULL WHEN typeof(${value}) = 'integer' THEN ${value} ELSE ${placeholder} END`;
    }

    const x = `CAST(${left.sql} AS REAL)`,
      y = `CAST(${right.sql} AS REAL)`;
    const value = `(${x} ${operator} ${y})`;
    const zero = operator === '/' ? `WHEN ${y} = 0 THEN ${placeholder} ` : '';

    return `CASE WHEN ${childFailed} THEN ${placeholder} WHEN ${nulls} THEN NULL WHEN NOT (${finite(x)} AND ${finite(y)}) THEN ${placeholder} ${zero}WHEN ${finite(value)} THEN ${value} ELSE ${placeholder} END`;
  },
  failed,
  flag(condition, filter) {
    return `MAX(CASE WHEN ${condition} THEN 1 ELSE 0 END) FILTER (WHERE ${filter})`;
  },
  accumulate(aggregate, input, filter) {
    const type = input.type;
    const call = (name: string) =>
      `${name}(${checkedValue(input, failed, (v) => v)}) FILTER (WHERE ${filter})`;

    if (aggregate === 'count' || aggregate === 'min' || aggregate === 'max')
      return { columns: [call(aggregate.toUpperCase())], value: ([v]) => v! };

    if (type === 'float64')
      return floatAccumulation(aggregate === 'avg', input, filter);

    // Native AVG accumulates approximately and never raises.
    if (aggregate === 'avg')
      return { columns: [call('AVG')], value: ([v]) => v! };

    return integerSum(input, filter);
  },
};
