import fc from 'fast-check';
import { propertyColumnTypes, propertyCustomerKeys } from './model.js';
import type { PropertyColumn, PropertyRow } from './model.js';
import type {
  Comparison,
  Predicate,
  PropertyQuery,
  ValueOperand,
} from './query.js';

/** Small domains make equal values, duplicates and boundaries likely. Sums stay within int64. */
const int64s = [
  0n,
  1n,
  -1n,
  2n,
  9007199254740993n,
  -9007199254740993n,
  1n << 59n,
];
const int32s = [0, 1, -1, 2, 2147483647, -2147483648];
/** Binary-exact values: sums do not depend on summation order. */
const float64s = [0, 0.5, -2, 1.25, 3.75];
/** Mixed case, multibyte and quotes separate byte order from locale order. */
const strings = ['', 'a', 'A', 'B', 'b', 'ab', 'a b', 'Z', 'é', '😀', "it's"];
const instants = [
  '1970-01-01T00:00:00.000000Z',
  '2026-10-01T00:00:00.123000Z',
  '2026-10-01T00:00:00.123400Z',
  '2026-10-02T00:00:00.000000Z',
  '9999-12-31T23:59:59.999999Z',
];
/** Canonical calendar dates, including ISO year zero and leap days. */
const dates = [
  '0000-02-29',
  '0001-01-01',
  '2024-02-29',
  '2026-10-01',
  '2026-10-02',
  '9999-12-31',
];
const comparisons: Comparison[] = ['=', '<>', '!=', '<', '<=', '>', '>='];
const columns = Object.keys(propertyColumnTypes) as PropertyColumn[];

/** Canonical millisecond spelling, when the instant has no sub-millisecond digits. */
function milliseconds(instant: string): string | undefined {
  return instant.slice(23, 26) === '000'
    ? `${instant.slice(0, 23)}Z`
    : undefined;
}

/** The same instant written one hour behind UTC. */
function offset(instant: string): string {
  const shifted = new Date(Date.parse(`${instant.slice(0, 23)}Z`) - 3_600_000);

  return `${shifted.toISOString().slice(0, 19)}.${instant.slice(20, 26)}-01:00`;
}

/** Stored text must be canonical; both canonical precisions are allowed. */
const storedInstant = fc
  .constantFrom(...instants)
  .chain((instant) =>
    fc.constantFrom(
      ...[instant, milliseconds(instant)].filter((v) => v !== undefined),
    ),
  );

const literalInstant = fc
  .constantFrom(...instants)
  .chain((instant) =>
    fc.constantFrom(
      ...[instant, milliseconds(instant), offset(instant)].filter(
        (v) => v !== undefined,
      ),
    ),
  );

function value(column: PropertyColumn): fc.Arbitrary<ValueOperand> {
  const type = propertyColumnTypes[column];
  const scalar: fc.Arbitrary<{
    value: ValueOperand['value'];
    literal: string;
  }> =
    type === 'int64'
      ? fc
          .constantFrom(...int64s)
          .map((v) => ({ value: v, literal: String(v) }))
      : type === 'int32'
        ? fc
            .constantFrom(...int32s)
            .map((v) => ({ value: v, literal: String(v) }))
        : type === 'float64'
          ? fc
              .constantFrom(...float64s)
              .map((v) => ({ value: v, literal: String(v) }))
          : type === 'boolean'
            ? fc.boolean().map((v) => ({
                value: v,
                literal: v ? 'TRUE' : 'FALSE',
              }))
            : (type === 'string'
                ? fc.constantFrom(...strings)
                : type === 'date'
                  ? fc.constantFrom(...dates)
                  : literalInstant
              ).map((v) => ({
                value: v,
                literal: `'${v.replaceAll("'", "''")}'`,
              }));

  return fc
    .record({ scalar, parameter: fc.boolean() })
    .map(({ scalar, parameter }) => ({ kind: 'value', ...scalar, parameter }));
}

const compare: fc.Arbitrary<Predicate> = fc
  .constantFrom(...columns)
  .chain((column) =>
    fc.record({
      op: fc.constantFrom(...comparisons),
      value: value(column),
      swap: fc.boolean(),
      column: fc.constant(column),
    }),
  )
  .map(({ op, value, swap, column }) => {
    const reference = { kind: 'column', column } as const;

    return {
      kind: 'compare',
      op,
      left: swap ? value : reference,
      right: swap ? reference : value,
    };
  });

const since: fc.Arbitrary<Predicate> = fc
  .record({ op: fc.constantFrom(...comparisons), swap: fc.boolean() })
  .map(({ op, swap }) => {
    const at = { kind: 'column', column: 'at' } as const;
    const self = { kind: 'since' } as const;

    return {
      kind: 'compare',
      op,
      left: swap ? self : at,
      right: swap ? at : self,
    };
  });

const nullTest: fc.Arbitrary<Predicate> = fc.record({
  kind: fc.constant('null'),
  column: fc.constantFrom(...columns),
  not: fc.boolean(),
});

const { predicate } = fc.letrec<{ predicate: Predicate }>((tie) => ({
  // Depth 3 with binary connectives stays within the parsed-node and parameter limits.
  predicate: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    fc.oneof(compare, since, nullTest),
    fc.record({
      kind: fc.constant('boolean'),
      op: fc.constantFrom('and', 'or'),
      args: fc.array(tie('predicate'), { minLength: 2, maxLength: 2 }),
    }),
    fc.record({ kind: fc.constant('not'), arg: tie('predicate') }),
  ),
}));

const aggregate = fc.oneof(
  fc.constant({ aggregate: 'count', argument: '*', distinct: false } as const),
  fc.record({
    aggregate: fc.constant('count' as const),
    argument: fc.constantFrom(...columns),
    distinct: fc.boolean(),
  }),
  fc.record({
    aggregate: fc.constantFrom('sum' as const, 'avg' as const),
    argument: fc.constantFrom<PropertyColumn>('n', 'small', 'ratio'),
    distinct: fc.constant(false),
  }),
  fc.record({
    aggregate: fc.constantFrom('min' as const, 'max' as const),
    argument: fc.constantFrom(...columns),
    distinct: fc.constant(false),
  }),
);

export const propertyQuery: fc.Arbitrary<PropertyQuery> = fc
  .record({
    aggregate,
    predicate: fc.option(predicate, { nil: undefined }),
    qualified: fc.boolean(),
  })
  .map(({ aggregate, predicate, qualified }) => ({
    ...aggregate,
    ...(predicate ? { predicate } : {}),
    qualified,
  }));

export const propertyRow: fc.Arbitrary<PropertyRow> = fc.record({
  customerId: fc.constantFrom(...propertyCustomerKeys),
  n: fc.option(fc.constantFrom(...int64s), { nil: null }),
  small: fc.option(fc.constantFrom(...int32s), { nil: null }),
  ratio: fc.option(fc.constantFrom(...float64s), { nil: null }),
  label: fc.option(fc.constantFrom(...strings), { nil: null }),
  flag: fc.option(fc.boolean(), { nil: null }),
  at: fc.option(storedInstant, { nil: null }),
  day: fc.option(fc.constantFrom(...dates), { nil: null }),
});
