import { expect, it } from 'vitest';
import { decodeComputed } from 'relate/consumer';
import { AnalyticalValueError } from 'relate/analytics';

it.each(['compact', 'full'] as const)(
  'decodes present computed fields with %s evidence without mutating the record',
  (evidence) => {
    const input = {
      status: 'ok',
      id: 'customer',
      data: {
        name: 'Acme',
        ordinaryInteger: '9007199254740993',
        count: '9007199254740993',
        latest: '2026-10-09T10:30:00.001Z',
        exact: '1969-12-31T23:59:59.999999Z',
        empty: null,
        flag: true,
        small: 12,
        average: 2.5,
        text: 'event',
      },
      meta: {
        evidence,
        computed: {
          count: { type: 'int64', nullable: false },
          latest: { type: 'timestamp', precision: 3, nullable: true },
          exact: { type: 'timestamp', precision: 6, nullable: false },
          empty: { type: 'int64', nullable: true },
          flag: { type: 'boolean', nullable: false },
          small: { type: 'int32', nullable: false },
          average: { type: 'float64', nullable: false },
          text: { type: 'string', nullable: false },
          forbidden: { type: 'int64', nullable: false },
          unavailable: { type: 'timestamp', precision: 3, nullable: true },
        },
        fields: {
          forbidden: { status: 'forbidden' },
          unavailable: { status: 'unavailable' },
        },
      },
    } as const;
    const before = structuredClone(input);
    const fields = decodeComputed(input);

    expect(fields).toEqual({
      count: 9007199254740993n,
      latest: new Date(input.data.latest),
      exact: input.data.exact,
      empty: null,
      flag: true,
      small: 12,
      average: 2.5,
      text: 'event',
    });
    expect(fields).not.toHaveProperty('forbidden');
    expect(fields).not.toHaveProperty('unavailable');
    expect(fields).not.toHaveProperty('name');
    expect(fields).not.toHaveProperty('ordinaryInteger');
    expect(input).toEqual(before);
    fields.latest?.setTime(0);
    expect(input.data.latest).toBe('2026-10-09T10:30:00.001Z');
    expect(decodeComputed(input).latest).toEqual(new Date(input.data.latest));
  },
);

it('accepts query records, not-found results and ordinary reads', () => {
  expect(
    decodeComputed({
      data: { count: '0' },
      meta: { computed: { count: { type: 'int64', nullable: false } } },
    }),
  ).toEqual({ count: 0n });
  expect(decodeComputed({ status: 'not-found' })).toEqual({});
  expect(decodeComputed({ data: { name: 'Acme' }, meta: {} })).toEqual({});
  expect(
    decodeComputed({
      data: {},
      meta: { computed: { count: { type: 'int64', nullable: false } } },
    }),
  ).toEqual({});
});

it.each([
  ['9223372036854775807', 9223372036854775807n],
  ['-9223372036854775808', -9223372036854775808n],
] as const)('decodes the int64 boundary %s exactly', (value, expected) => {
  expect(
    decodeComputed({
      data: { count: value },
      meta: { computed: { count: { type: 'int64', nullable: false } } },
    }),
  ).toEqual({ count: expected });
});

it.each([
  ['9223372036854775808', { type: 'int64', nullable: false }],
  ['-9223372036854775809', { type: 'int64', nullable: false }],
  ['2\n', { type: 'int64', nullable: false }],
  ['02', { type: 'int64', nullable: false }],
  ['-0', { type: 'int64', nullable: false }],
  [2, { type: 'int64', nullable: false }],
  [2n, { type: 'int64', nullable: false }],
  [null, { type: 'int64', nullable: false }],
  [undefined, { type: 'int64', nullable: true }],
  [2147483648, { type: 'int32', nullable: false }],
  [Infinity, { type: 'float64', nullable: false }],
  [NaN, { type: 'float64', nullable: false }],
  [1, { type: 'boolean', nullable: false }],
  [
    '2026-10-09T10:30:00.000001Z',
    { type: 'timestamp', precision: 3, nullable: false },
  ],
  [
    '2026-10-09T10:30:00.000Z',
    { type: 'timestamp', precision: 6, nullable: false },
  ],
  ['private-value', { type: 'unknown', nullable: false }],
  ['private-value', { type: 'string' }],
  ['private-value', null],
  ['private-value', undefined],
])(
  'rejects malformed present values and metadata without exposing values %#',
  (value, type) => {
    const input = {
      data: { field: value },
      meta: { computed: { field: type } },
    };

    expect(() => decodeComputed(input as never)).toThrow(AnalyticalValueError);
    expect(() => decodeComputed(input as never)).toThrow(
      'Value does not match its analytical type',
    );
  },
);

it.each([
  null,
  undefined,
  [],
  { data: [], meta: {} },
  { data: {}, meta: null },
  { data: {}, meta: { computed: [] } },
  { data: {}, meta: { computed: null } },
])('rejects malformed record envelopes %#', (input) => {
  expect(() => decodeComputed(input as never)).toThrow(AnalyticalValueError);
});

it('reads only own metadata and own data without prototype setters', () => {
  const input = JSON.parse(
    '{"data":{"__proto__":"2","constructor":"3"},"meta":{"computed":{"__proto__":{"type":"int64","nullable":false},"constructor":{"type":"int64","nullable":false}}}}',
  );
  const decoded = decodeComputed(input);

  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  expect(decoded['__proto__']).toBe(2n);
  expect(decoded['constructor']).toBe(3n);
  const inheritedData = {
    data: Object.create({ count: '2' }),
    meta: { computed: { count: { type: 'int64', nullable: false } } },
  };

  expect(decodeComputed(inheritedData as never)).toEqual({});
  expect(
    decodeComputed({
      data: { count: '2' },
      meta: Object.create({
        computed: { count: { type: 'int64', nullable: false } },
      }),
    }),
  ).toEqual({});
});
