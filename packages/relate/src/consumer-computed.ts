import type { ComputedResultType } from '@relate/protocol';
import {
  AnalyticalValueError,
  decodeAnalyticalValue,
} from './analytics/values.js';

/** Both get results and individual query records carry this metadata. */
interface ComputableRecord {
  readonly data: Readonly<Record<string, unknown>>;
  readonly meta: {
    readonly computed?: Readonly<Record<string, ComputedResultType>>;
  };
}

type ComputableResult = ComputableRecord | { readonly status: 'not-found' };

type ValueTypes = {
  boolean: boolean;
  string: string;
  int32: number;
  int64: bigint;
  float64: number;
  timestamp: Date | string;
};

type DecodedValue<T extends ComputedResultType> =
  | (T extends { readonly type: 'timestamp'; readonly precision: 3 }
      ? Date
      : T extends { readonly type: 'timestamp'; readonly precision: 6 }
        ? string
        : ValueTypes[T['type']])
  | (true extends T['nullable'] ? null : never);

type ComputedTypes<R> = R extends ComputableRecord
  ? NonNullable<R['meta']['computed']>
  : never;

/**
 * A separate bag of computed values; every field stays optional because reads
 * can omit it. Literal metadata narrows the value type. Authored SQL has runtime
 * result types, so typed reads retain the decoded scalar union.
 */
export type DecodedComputed<R extends ComputableResult> = [
  Extract<R, ComputableRecord>,
] extends [never]
  ? Record<never, never>
  : {
      readonly [
        K in keyof Extract<R, ComputableRecord>['data'] & keyof ComputedTypes<R>
      ]?: DecodedValue<ComputedTypes<R>[K]>;
    };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Decode only present fields named by `meta.computed`, without changing the
 * original record or its evidence. Int64 becomes bigint, millisecond timestamps
 * become Date, and microsecond timestamps remain exact canonical UTC strings.
 * A not-found result or absent computed metadata returns an empty object.
 * Malformed present values or their metadata throw AnalyticalValueError without
 * input values. Omitted fields are not decoded.
 */
export function decodeComputed<R extends ComputableResult>(
  result: R,
): DecodedComputed<R> {
  const input: unknown = result;

  if (!record(input)) throw new AnalyticalValueError();

  if (Object.hasOwn(input, 'status') && input.status === 'not-found')
    return {} as DecodedComputed<R>;

  if (
    (Object.hasOwn(input, 'status') && input.status !== 'ok') ||
    !Object.hasOwn(input, 'data') ||
    !Object.hasOwn(input, 'meta') ||
    !record(input.data) ||
    !record(input.meta)
  )
    throw new AnalyticalValueError();

  const computed = Object.hasOwn(input.meta, 'computed')
    ? input.meta.computed
    : undefined;

  if (computed === undefined) return {} as DecodedComputed<R>;

  if (!record(computed)) throw new AnalyticalValueError();

  const data = input.data;

  return Object.fromEntries(
    Object.entries(computed).flatMap(([name, type]) =>
      Object.hasOwn(data, name)
        ? [
            [
              name,
              decodeAnalyticalValue(data[name], type as ComputedResultType),
            ],
          ]
        : [],
    ),
  ) as DecodedComputed<R>;
}
