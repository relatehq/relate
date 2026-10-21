import type { LogicalType, ComputedResultType } from '@relate/protocol';

export type AnalyticalScalar = string | number | boolean | null;
/** Microsecond instants stay canonical strings; Date cannot preserve them. */
export type DecodedAnalyticalScalar = AnalyticalScalar | bigint | Date;

export type TypedValue =
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'int32' | 'float64'; readonly value: number }
  | { readonly type: 'int64'; readonly value: bigint }
  | {
      readonly type: 'timestamp';
      readonly precision: 3 | 6;
      readonly value: string;
    }
  | (LogicalType & { readonly value: null });

/** Sanitized: do not include the input value or driver error in public diagnostics. */
export class AnalyticalValueError extends Error {
  constructor() {
    super('Value does not match its analytical type');
    this.name = 'AnalyticalValueError';
  }
}

function invalid(): never {
  throw new AnalyticalValueError();
}

const int64Min = -(1n << 63n);
const int64Max = (1n << 63n) - 1n;

function integer64(value: unknown): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid();

    value = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^-?(0|[1-9][0-9]*)$/.test(value) || value.length > 20) invalid();

    value = BigInt(value);
  }

  if (typeof value !== 'bigint' || value < int64Min || value > int64Max)
    invalid();

  return value;
}

/** Normalize an ISO instant without rounding or discarding fractional digits. */
export function canonicalTimestamp(value: string, precision: 3 | 6): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );

  if (!match || (precision !== 3 && precision !== 6)) invalid();

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = '',
    zone,
  ] = match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const hour = Number(hourText),
    minute = Number(minuteText),
    second = Number(secondText);
  const local = new Date(0);

  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);

  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    /[1-9]/.test(fraction.slice(precision))
  )
    invalid();

  let offset = 0;

  if (zone !== 'Z') {
    const hours = Number(zone!.slice(1, 3)),
      minutes = Number(zone!.slice(4, 6));

    if (hours > 23 || minutes > 59) invalid();

    offset = (hours * 60 + minutes) * (zone![0] === '-' ? -1 : 1);
  }

  const utc = new Date(local.getTime() - offset * 60_000);

  if (utc.getUTCFullYear() < 0 || utc.getUTCFullYear() > 9999) invalid();

  return `${utc.toISOString().slice(0, 19)}.${fraction.slice(0, precision).padEnd(precision, '0')}Z`;
}

/** Convert a lossless driver scalar to the declared, stable JSON encoding. */
export function encodeAnalyticalValue(
  value: unknown,
  result: ComputedResultType,
): AnalyticalScalar {
  if (
    !result ||
    typeof result.nullable !== 'boolean' ||
    !['boolean', 'string', 'int32', 'int64', 'float64', 'timestamp'].includes(
      result.type,
    ) ||
    (result.type === 'timestamp' &&
      result.precision !== 3 &&
      result.precision !== 6)
  )
    invalid();

  if (value === null) {
    if (!result.nullable) invalid();

    return null;
  }

  switch (result.type) {
    case 'int64':
      return integer64(value).toString();
    case 'int32': {
      if (typeof value === 'bigint') {
        if (value < -2147483648n || value > 2147483647n) invalid();

        value = Number(value);
      }

      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < -2147483648 ||
        value > 2147483647
      )
        invalid();

      return Object.is(value, -0) ? 0 : value;
    }
    case 'float64': {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid();

      return Object.is(value, -0) ? 0 : value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') invalid();

      return value;
    }
    case 'string': {
      if (typeof value !== 'string') invalid();

      return value;
    }
    case 'timestamp': {
      if (
        typeof value !== 'string' ||
        canonicalTimestamp(value, result.precision) !== value
      )
        invalid();

      return value;
    }
    default:
      return invalid();
  }
}

/** Contextual parameter decoding accepts JSON values only, never lossy coercion. */
export function parseAnalyticalValue(
  value: unknown,
  type: LogicalType,
): TypedValue {
  if (value === null || typeof value === 'bigint') invalid();

  if (type.type === 'timestamp') {
    if (typeof value !== 'string') invalid();

    return { ...type, value: canonicalTimestamp(value, type.precision) };
  }

  if (type.type === 'int64') return { type: 'int64', value: integer64(value) };

  const encoded = encodeAnalyticalValue(value, { ...type, nullable: false });

  // The shared encoder has checked the discriminated type and excluded null.
  return { ...type, value: encoded } as TypedValue;
}

/** Decode wire JSON while preserving nulls and exact microsecond timestamps. */
export function decodeAnalyticalValue(
  value: unknown,
  result: ComputedResultType,
): DecodedAnalyticalScalar {
  const encoded = encodeAnalyticalValue(value, result);

  // Driver-only bigint input is not valid JSON, even for an int64 field.
  if (
    typeof value === 'bigint' ||
    (result.type === 'int64' && value !== null && typeof value !== 'string')
  )
    invalid();

  if (encoded === null) return null;

  if (result.type === 'int64') {
    if (encoded !== value) invalid();

    return BigInt(encoded as string);
  }

  if (result.type === 'timestamp' && result.precision === 3)
    return new Date(encoded as string);

  return encoded;
}
