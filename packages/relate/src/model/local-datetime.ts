import type { ScalarSchema } from '@relate/protocol';

/** Calendar precision; local values deliberately carry no UTC offset. */
export type LocalDateTimePrecision = NonNullable<ScalarSchema['precision']>;

export const localDateTimePrecisions = {
  second: 'second',
  millisecond: 'millisecond',
} as const satisfies Record<LocalDateTimePrecision, LocalDateTimePrecision>;

const patterns = {
  second: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/,
  millisecond: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/,
} satisfies Record<LocalDateTimePrecision, RegExp>;
const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** An exact sortable calendar tuple encoded below Number.MAX_SAFE_INTEGER. */
export function localDateTimeValue(
  value: unknown,
  precision: LocalDateTimePrecision,
): number | undefined {
  if (typeof value !== 'string') return undefined;

  const parts = patterns[precision].exec(value);

  if (!parts) return undefined;

  const [year, month, day, hour, minute, second, millis = 0] = parts
    .slice(1)
    .map(Number) as [number, number, number, number, number, number, number?];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : monthLengths[month - 1];

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days! ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;

  return (
    (((((year * 13 + month) * 32 + day) * 24 + hour) * 60 + minute) * 60 +
      second) *
      1000 +
    millis
  );
}
