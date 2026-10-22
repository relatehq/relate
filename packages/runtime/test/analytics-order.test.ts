import { expect, it } from 'vitest';
import { prepareComputedOrder } from '../src/analytics/index.js';
import type { ComputedField } from '../src/analytics/index.js';
import type { AnalyticalScalar, ComputedResultType } from 'relate/analytics';

function fields(value: AnalyticalScalar): Record<string, ComputedField> {
  return {
    value: {
      status: 'available',
      value,
      computedAt: '2026-10-01T00:00:00.000Z',
      columns: [],
      input: {
        associationId: 'events',
        datasetId: 'events',
        bindingRevision: 'revision',
        readAt: '2026-10-01T00:00:00.000Z',
      },
      dependencies: {},
    },
  };
}

it.each([
  [
    { type: 'int64', nullable: true },
    ['-9007199254740993', '-10', '9', '10', '9007199254740993', null],
  ],
  [{ type: 'int32', nullable: true }, [-2147483648, 0, 2147483647, null]],
  [{ type: 'float64', nullable: true }, [-0.5, 0, 0.1, null]],
  [{ type: 'boolean', nullable: true }, [false, true, null]],
  [{ type: 'string', nullable: true }, ['', 'A', 'a', 'z', null]],
  [
    { type: 'timestamp', precision: 6, nullable: true },
    ['2026-10-01T00:00:00.000001Z', '2026-10-01T00:00:00.000002Z', null],
  ],
] as const)(
  'compares %j precisely in both directions and validates cursor positions',
  (type, values) => {
    for (const direction of ['asc', 'desc'] as const) {
      const ordering = prepareComputedOrder({
        types: { value: type },
        where: {},
        orderBy: [{ field: 'value', direction }],
      });
      const positions = values.map((value, i) =>
        ordering.position(String(i), fields(value)),
      );
      const sorted = [...positions].reverse().sort(ordering.compare);
      const expected =
        direction === 'asc'
          ? [...values]
          : [...values.slice(0, -1)].reverse().concat(null);

      expect(sorted.map((position) => position.values[0])).toEqual(expected);

      for (const position of positions)
        expect(ordering.parsePosition(JSON.stringify(position))).toEqual(
          position,
        );
    }
  },
);

it('normalizes timestamp bounds without losing microseconds', () => {
  const ordering = prepareComputedOrder({
    types: { value: { type: 'timestamp', precision: 6, nullable: true } },
    where: {
      value: {
        gt: '2026-10-01T01:00:00.000001+01:00',
        lte: '2026-10-01T00:00:00.000002Z',
      },
    },
    orderBy: [],
  });

  expect(ordering.matches(fields('2026-10-01T00:00:00.000001Z'))).toBe(false);
  expect(ordering.matches(fields('2026-10-01T00:00:00.000002Z'))).toBe(true);
});

it.each([
  [{ type: 'int64', nullable: false }, { eq: '-0' }],
  [{ type: 'int64', nullable: false }, { gt: 1 }],
  [{ type: 'boolean', nullable: true }, { gt: true }],
  [{ type: 'string', nullable: true }, { lt: 'z' }],
  [{ type: 'float64', nullable: true }, { eq: Infinity }],
  [
    { type: 'timestamp', precision: 3, nullable: true },
    { eq: '2026-10-01T00:00:00.000001Z' },
  ],
] as const)('rejects incompatible %j bounds %j', (type, value) => {
  expect(() =>
    prepareComputedOrder({
      types: { value: type as ComputedResultType },
      where: { value },
      orderBy: [],
    }),
  ).toThrow();
});

it('compares multiple order fields before the ID tie breaker', () => {
  const ordering = prepareComputedOrder({
    types: {
      value: { type: 'int64', nullable: true },
      second: { type: 'string', nullable: true },
    },
    where: {},
    orderBy: [
      { field: 'value', direction: 'desc' },
      { field: 'second', direction: 'asc' },
    ],
  });

  expect(
    ordering.compare(
      { id: 'z', values: ['10', 'a'] },
      { id: 'a', values: ['10', 'b'] },
    ),
  ).toBe(-1);
  expect(
    ordering.compare(
      { id: 'z', values: ['10', 'a'] },
      { id: 'a', values: ['10', 'a'] },
    ),
  ).toBe(1);
  expect(
    ordering.compare(
      { id: 'z', values: ['9', null] },
      { id: 'a', values: [null, 'a'] },
    ),
  ).toBe(-1);
});

it('uses ID alone when only computed filters require a full scope', () => {
  const ordering = prepareComputedOrder({
    types: { value: { type: 'int64', nullable: false } },
    where: { value: { in: [] } },
    orderBy: [],
  });

  expect(ordering.matches(fields('1'))).toBe(false);
  expect(ordering.position('one', fields('1'))).toEqual({
    id: 'one',
    values: [],
  });
  expect(
    ordering.compare({ id: 'one', values: [] }, { id: 'two', values: [] }),
  ).toBe(-1);
});
