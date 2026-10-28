import { checkedValue } from 'relate/analytics';
import type {
  CheckedAccumulation,
  CheckedArithmeticDialect,
  CheckedInput,
  CheckedType,
} from 'relate/analytics';

// DuckDB double arithmetic never raises; integer nodes widen to HUGEINT, whose
// product of two int64 values cannot overflow.

const fn = (name: string, ...args: string[]) =>
  `"system"."main".${name}(${args.join(', ')})`;
const double = (value: number) => `CAST('${String(value)}' AS DOUBLE)`;
const hugeint = (value: bigint) => `CAST('${value}' AS HUGEINT)`;
const nan = `CAST('nan' AS DOUBLE)`;
const placeholder = hugeint(2n ** 100n);
const big = double(2 ** 512);
const small = double(2 ** -512);
const inInt64 = (value: string) =>
  `(${value} >= ${hugeint(-(2n ** 63n))} AND ${value} <= ${hugeint(2n ** 63n - 1n)})`;
const finite = (value: string) => fn('isfinite', value);
const failed = (value: string, type: CheckedType) =>
  type === 'float64' ? `NOT ${finite(value)}` : `NOT ${inInt64(value)}`;

function floatAccumulation(
  average: boolean,
  input: CheckedInput,
  filter: string,
): CheckedAccumulation {
  const bucket = (large: boolean) =>
    `${fn(
      'sum',
      checkedValue(
        input,
        failed,
        (v) =>
          `CASE WHEN ${fn('abs', v)} ${large ? '>=' : '<'} ${big} THEN ${large ? `${v} * ${small}` : v} END`,
      ),
    )} FILTER (WHERE ${filter})`;
  const columns = [bucket(true), bucket(false)];

  if (average)
    columns.push(
      `${fn(
        'count',
        checkedValue(input, failed, (v) => v),
      )} FILTER (WHERE ${filter})`,
    );

  const total = ([hi, lo, count]: readonly string[]) => {
    const n = count ? `CAST(${count} AS DOUBLE)` : double(1);

    return `(COALESCE(${hi}, ${double(0)}) / ${n}) * ${big} + COALESCE(${lo}, ${double(0)}) / ${n}`;
  };
  const empty = ([hi, lo]: readonly string[]) =>
    `${hi} IS NULL AND ${lo} IS NULL`;
  // Power-of-two rescaling is exact, so it overflows exactly when out of range.
  const bad = (refs: readonly string[]) => `NOT ${finite(total(refs))}`;

  return {
    columns,
    value: (refs) =>
      `CASE WHEN ${empty(refs)} OR ${bad(refs)} THEN NULL ELSE ${total(refs)} END`,
    failed: (refs) => `(NOT (${empty(refs)}) AND (${bad(refs)}))`,
  };
}

export const checked: CheckedArithmeticDialect = {
  operand(sql, type) {
    return type === 'float64' ? sql : `CAST(${sql} AS HUGEINT)`;
  },
  node(operator, left, right, result) {
    const childFailed = `${failed(left.sql, left.type)} OR ${failed(right.sql, right.type)}`;
    const nulls = `${left.sql} IS NULL OR ${right.sql} IS NULL`;

    if (result === 'int64') {
      const value = `(${left.sql} ${operator} ${right.sql})`;

      return `CASE WHEN ${childFailed} THEN ${placeholder} WHEN ${nulls} THEN NULL WHEN ${inInt64(value)} THEN ${value} ELSE ${placeholder} END`;
    }

    // A placeholder never reaches the int64 cast, even under constant folding.
    const float = (child: typeof left) =>
      child.type === 'float64'
        ? child.sql
        : `CAST(CAST(CASE WHEN ${failed(child.sql, child.type)} THEN 0 ELSE ${child.sql} END AS BIGINT) AS DOUBLE)`;
    const value = `(${float(left)} ${operator} ${float(right)})`;
    const zero = operator === '/' ? `WHEN ${right.sql} = 0 THEN ${nan} ` : '';

    return `CASE WHEN ${childFailed} THEN ${nan} WHEN ${nulls} THEN NULL ${zero}WHEN ${finite(value)} THEN ${value} ELSE ${nan} END`;
  },
  failed,
  flag(condition, filter) {
    return `${fn('max', `CASE WHEN ${condition} THEN 1 ELSE 0 END`)} FILTER (WHERE ${filter})`;
  },
  accumulate(aggregate, input, filter) {
    const type = input.type;
    const call = (name: string) =>
      `${fn(
        name,
        checkedValue(input, failed, (v) => v),
      )} FILTER (WHERE ${filter})`;

    if (aggregate === 'count')
      return { columns: [call('count')], value: ([v]) => v! };

    if (aggregate === 'min' || aggregate === 'max')
      return {
        columns: [call(aggregate)],
        value: ([v]) => (type === 'int64' ? `CAST(${v} AS BIGINT)` : v!),
      };

    if (type === 'float64')
      return floatAccumulation(aggregate === 'avg', input, filter);

    if (aggregate === 'avg')
      return { columns: [call('avg')], value: ([v]) => `CAST(${v} AS DOUBLE)` };

    // HUGEINT sums are exact; only the final total must fit int64.
    return {
      columns: [call('sum')],
      value: ([v]) => `CASE WHEN ${inInt64(v!)} THEN CAST(${v} AS BIGINT) END`,
      failed: ([v]) => `NOT ${inInt64(v!)}`,
    };
  },
};
