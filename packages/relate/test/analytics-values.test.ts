import { expect, it } from 'vitest';
import {
  AnalyticalValueError,
  canonicalDate,
  canonicalTimestamp,
  decodeAnalyticalValue,
  encodeAnalyticalValue,
  parseAnalyticalValue,
} from 'relate/analytics';
import type { LogicalType, ComputedResultType } from 'relate/analytics';
import { scalarCases } from '../../../tests/support/sql-corpus/scalars.js';

it.each(scalarCases)(
  'encodes $name without changing its JSON type',
  ({ input, result, json }) => {
    expect(encodeAnalyticalValue(input, result)).toBe(json);
    expect(
      JSON.parse(
        JSON.stringify({ value: encodeAnalyticalValue(input, result) }),
      ),
    ).toEqual({ value: json });
  },
);

it.each([
  ['2026-10-01T02:30:00+02:30', 3, '2026-10-01T00:00:00.000Z'],
  ['2026-01-01T00:00:00.123456+01:00', 6, '2025-12-31T23:00:00.123456Z'],
  ['1969-12-31T23:59:59.999999Z', 6, '1969-12-31T23:59:59.999999Z'],
  ['0000-02-29T00:00:00Z', 3, '0000-02-29T00:00:00.000Z'],
  ['2024-02-29T12:00:00.123000Z', 3, '2024-02-29T12:00:00.123Z'],
] as const)('normalizes %s exactly', (input, precision, expected) => {
  expect(canonicalTimestamp(input, precision)).toBe(expected);
  expect(parseAnalyticalValue(input, { type: 'timestamp', precision })).toEqual(
    { type: 'timestamp', precision, value: expected },
  );
});

it.each([
  '2026-02-29T00:00:00Z',
  '2026-04-31T00:00:00Z',
  '2026-00-01T00:00:00Z',
  '2026-01-00T00:00:00Z',
  '2026-01-01T24:00:00Z',
  '2026-01-01T00:60:00Z',
  '2026-01-01T00:00:60Z',
  '2026-01-01T00:00:00+24:00',
  '2026-01-01T00:00:00+00:60',
  '2026-01-01',
  '2026-01-01T00:00:00',
  '2026-01-01T00:00:00.1234567Z',
  '0000-01-01T00:00:00+01:00',
  '9999-12-31T23:59:59-01:00',
])('rejects malformed or unrepresentable instant %s', (input) => {
  expect(() => canonicalTimestamp(input, 6)).toThrow(AnalyticalValueError);
});

it.each(['2024-02-29', '0000-01-01', '0000-02-29', '2000-02-29', '9999-12-31'])(
  'accepts the canonical calendar date %s unchanged',
  (input) => {
    const type = { type: 'date', nullable: true } as const;

    expect(canonicalDate(input)).toBe(input);
    expect(parseAnalyticalValue(input, { type: 'date' })).toEqual({
      type: 'date',
      value: input,
    });
    expect(encodeAnalyticalValue(input, type)).toBe(input);
    expect(decodeAnalyticalValue(input, type)).toBe(input);
  },
);

it.each([
  '2026-02-29',
  '1900-02-29',
  '2026-04-31',
  '2026-00-01',
  '2026-13-01',
  '2026-01-00',
  '2026-1-01',
  '2026-01-1',
  '26-01-01',
  '10000-01-01',
  '-0001-01-01',
  '+2026-01-01',
  ' 2026-01-01',
  '2026-01-01 ',
  '2026-01-01T00:00:00Z',
  '2026-01-01Z',
  '2026-01-01+01:00',
  '2026/01/01',
  'infinity',
  '-infinity',
  '',
])('rejects the non-canonical date %j', (input) => {
  expect(() => canonicalDate(input)).toThrow(AnalyticalValueError);
  expect(() => parseAnalyticalValue(input, { type: 'date' })).toThrow(
    AnalyticalValueError,
  );
  expect(() =>
    decodeAnalyticalValue(input, { type: 'date', nullable: false }),
  ).toThrow(AnalyticalValueError);
});

it('keeps dates as text: never Date, never a number, and null only when nullable', () => {
  expect(() =>
    encodeAnalyticalValue(new Date('2026-01-01'), {
      type: 'date',
      nullable: false,
    }),
  ).toThrow(AnalyticalValueError);
  expect(() => parseAnalyticalValue(20260101, { type: 'date' })).toThrow(
    AnalyticalValueError,
  );
  expect(() => parseAnalyticalValue(null, { type: 'date' })).toThrow(
    AnalyticalValueError,
  );
  expect(decodeAnalyticalValue(null, { type: 'date', nullable: true })).toBe(
    null,
  );
  expect(() =>
    decodeAnalyticalValue(null, { type: 'date', nullable: false }),
  ).toThrow(AnalyticalValueError);
});

it('never truncates microseconds into milliseconds', () => {
  expect(() => canonicalTimestamp('2026-01-01T00:00:00.000001Z', 3)).toThrow(
    AnalyticalValueError,
  );
  expect(
    decodeAnalyticalValue('2026-01-01T00:00:00.000001Z', {
      type: 'timestamp',
      precision: 6,
      nullable: false,
    }),
  ).toBe('2026-01-01T00:00:00.000001Z');
  expect(
    decodeAnalyticalValue('2026-01-01T00:00:00.001Z', {
      type: 'timestamp',
      precision: 3,
      nullable: false,
    }),
  ).toEqual(new Date('2026-01-01T00:00:00.001Z'));
});

it.each([
  [{ type: 'int64' }, 9223372036854775808n],
  [{ type: 'int64' }, '-9223372036854775809'],
  [{ type: 'int64' }, 9007199254740992],
  [{ type: 'int64' }, '1.0'],
  [{ type: 'int64' }, '01'],
  [{ type: 'int64' }, '-0'],
  [{ type: 'string' }, 'nul\0key'],
  [{ type: 'int64' }, true],
  [{ type: 'int32' }, 2147483648n],
  [{ type: 'int32' }, -2147483649],
  [{ type: 'int32' }, 1.5],
  [{ type: 'float64' }, NaN],
  [{ type: 'float64' }, Infinity],
  [{ type: 'float64' }, -Infinity],
  [{ type: 'boolean' }, 1],
  [{ type: 'string' }, {}],
  [{ type: 'timestamp', precision: 3 }, new Date()],
  [{ type: 'timestamp', precision: 3 }, '2026-01-01T00:00:00Z'],
] satisfies [LogicalType, unknown][])(
  'rejects incompatible driver result %#',
  (type, value) => {
    expect(() =>
      encodeAnalyticalValue(value, { ...type, nullable: false }),
    ).toThrow(AnalyticalValueError);
  },
);

it('checks parameter JSON types without coercion or null widening', () => {
  expect(parseAnalyticalValue('9007199254740993', { type: 'int64' })).toEqual({
    type: 'int64',
    value: 9007199254740993n,
  });
  expect(parseAnalyticalValue(42, { type: 'int64' })).toEqual({
    type: 'int64',
    value: 42n,
  });
  expect(() => parseAnalyticalValue(42n, { type: 'int64' })).toThrow(
    AnalyticalValueError,
  );
  expect(() => parseAnalyticalValue('42', { type: 'int32' })).toThrow(
    AnalyticalValueError,
  );
  expect(() => parseAnalyticalValue(null, { type: 'string' })).toThrow(
    AnalyticalValueError,
  );
  expect(() =>
    encodeAnalyticalValue(null, { type: 'int64', nullable: false }),
  ).toThrow(AnalyticalValueError);
});

it('decodes wire values exactly and rejects unknown result types', () => {
  expect(
    decodeAnalyticalValue('9007199254740993', {
      type: 'int64',
      nullable: false,
    }),
  ).toBe(9007199254740993n);
  expect(
    decodeAnalyticalValue(null, { type: 'int64', nullable: true }),
  ).toBeNull();
  expect(() =>
    decodeAnalyticalValue(2, { type: 'int64', nullable: false }),
  ).toThrow(AnalyticalValueError);
  expect(() =>
    decodeAnalyticalValue(2n, { type: 'int64', nullable: false }),
  ).toThrow(AnalyticalValueError);
  expect(() =>
    decodeAnalyticalValue('-0', { type: 'int64', nullable: false }),
  ).toThrow(AnalyticalValueError);
  expect(() =>
    decodeAnalyticalValue('private value', {
      type: 'unknown',
      nullable: false,
    } as unknown as ComputedResultType),
  ).toThrow('Value does not match its analytical type');
});

it.each([
  null,
  undefined,
  { type: 'unknown', nullable: true },
  { type: 'timestamp', precision: 9, nullable: true },
  { type: 'int64' },
])('rejects invalid type metadata even for null %#', (result) => {
  expect(() =>
    decodeAnalyticalValue(null, result as ComputedResultType),
  ).toThrow(AnalyticalValueError);
});
