import { invalid, SpikeError } from './contracts.js';
import type { Scalar, LogicalType, ResolvedExpression } from './contracts.js';

export function inputValue(
  value: Scalar | undefined,
  type: LogicalType,
): Scalar {
  if (value === undefined || value === null) invalid('invalid-value');

  if (type === 'int64') {
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      invalid('invalid-value');

    if (!/^-?\d+$/.test(String(value))) invalid('invalid-value');

    const integer = BigInt(value);

    if (integer < -(2n ** 63n) || integer >= 2n ** 63n)
      invalid('invalid-value');

    return integer.toString();
  }

  if (type === 'float64') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      invalid('invalid-value');

    return value;
  }

  if (typeof value !== 'string') invalid('invalid-value');

  if (type === 'timestamp') {
    // Spike supports milliseconds only. Reject excess precision, invalid dates,
    // date-only inputs and local times instead of silently truncating them.
    const match =
      /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-]\d\d:\d\d)$/.exec(
        value,
      );

    if (
      !match ||
      Number(match[2]) > 23 ||
      Number(match[3]) > 59 ||
      Number(match[4]) > 59 ||
      !Number.isFinite(Date.parse(value))
    )
      invalid('invalid-value');

    if (
      new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]
    )
      invalid('invalid-value');

    return new Date(value).toISOString();
  }

  return value;
}

/** Driver values must match the contract, including nullability and exact ints. */
export function resultValue(
  value: unknown,
  expression: Pick<ResolvedExpression, 'type' | 'nullable'>,
): Scalar {
  if (value === null && expression.nullable) return null;

  try {
    if (
      expression.type === 'int64' &&
      typeof value !== 'bigint' &&
      typeof value !== 'string'
    )
      throw new Error();

    if (expression.type === 'timestamp') {
      if (value instanceof Date) return value.toISOString();

      if (typeof value !== 'string' || inputValue(value, 'timestamp') !== value)
        throw new Error();
    }

    return inputValue(
      typeof value === 'bigint' ? value.toString() : (value as Scalar),
      expression.type,
    );
  } catch {
    throw new SpikeError('invalid-result', 'result-type');
  }
}
