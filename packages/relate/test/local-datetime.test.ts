import { expect, it } from 'vitest';
import { localDateTime } from 'relate';
import { localDateTimeValue } from 'relate/model';

it('validates precision, leap years, offsets and calendar components without Date parsing', () => {
  const seconds = localDateTime({ precision: 'second' });
  const millis = localDateTime({ precision: 'millisecond' });

  for (const value of [
    '2000-02-29T23:59:59',
    '2026-12-31T23:59:59',
    '0001-01-01T00:00:00',
  ])
    expect(seconds.safeParse(value).success).toBe(true);

  for (const value of [
    '1900-02-29T00:00:00',
    '2026-02-29T00:00:00',
    '2026-01-01T24:00:00',
    '2026-01-01T00:00:60',
    '0000-01-01T00:00:00',
    '2026-01-01',
    '2026-01-01T00:00:00Z',
  ])
    expect(seconds.safeParse(value).success).toBe(false);

  expect(millis.safeParse('2026-01-01T00:00:00.001').success).toBe(true);
  expect(millis.safeParse('2026-01-01T00:00:00.1').success).toBe(false);
  expect(millis.safeParse('2026-01-01T00:00:00').success).toBe(false);
  expect(localDateTimeValue('2026-12-31T23:59:59', 'second')).toBeLessThan(
    localDateTimeValue('2027-01-01T00:00:00', 'second')!,
  );
});
