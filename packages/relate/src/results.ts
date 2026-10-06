import { ReadError } from '@relate/protocol';

type FieldResult =
  | { readonly status: 'not-found' }
  | { readonly status: 'ok'; readonly data: object };

type ResultData<R extends FieldResult> = Extract<
  R,
  { readonly status: 'ok' }
>['data'];

// Walk tuples so a dynamic array cannot claim every possible key was checked.
// Distribute a union-valued tuple entry: checking 'name' OR 'status' does not
// establish that both are present.
type PresentFields<D, F extends readonly (keyof D)[]> = F extends readonly [
  infer First extends keyof D,
  ...infer Rest extends readonly (keyof D)[],
]
  ? (string extends First
      ? unknown
      : First extends keyof D
        ? { readonly [K in First]-?: Exclude<D[K], undefined> }
        : never) &
      PresentFields<D, Rest>
  : unknown;

/**
 * Require specific fields on an already returned read result.
 *
 * Checks that `result.status` is `ok` and every named field is an own property
 * of `result.data` whose value is not `undefined`. On success, narrows the
 * result to `ok` and removes `undefined` from the checked fields' types.
 * Other fields stay optional; the original result and its evidence are unchanged.
 *
 * Presence is independent of freshness: an authorized stale value passes.
 * This function does not fetch, refresh, validate a schema, or grant access.
 * It trusts the read result's existing schema and authorization checks. Valid
 * `null`, `false`, `0`, and empty strings pass. Nullable schema types retain
 * `null`; an action requiring a non-null value must check that separately.
 *
 * This is stricter about values than `requireComplete`: complete evidence can
 * describe a known absent optional field, which fails this assertion. It only
 * requires the named fields, so unrelated missing fields do not cause failure.
 *
 * @param result - A schema-validated, authorized read result. Both protocol
 * JSON results and results with schema-specific field types are supported.
 * @param fields - Field names to require. Use an inline array or `as const`
 * tuple for precise narrowing. Dynamic arrays are checked at runtime but do
 * not narrow individual fields. Checking a union-valued name establishes only
 * that one of those fields is present. An empty array checks only `status: 'ok'`.
 * @returns Nothing; narrows `result` in the calling scope on success. Protocol
 * JSON values remain JSON values; this assertion does not infer a schema.
 * @throws {ReadError} With code `incomplete` if the result is `not-found` or
 * any requested value is missing/undefined. The error does not distinguish
 * hidden, absent, unselected, or unavailable fields or include their values.
 *
 * @example
 * ```ts
 * import { assertFields } from 'relate';
 *
 * const customer = await runtime.read(principal, 'customer', customerId, {
 *   select: ['name', 'status'],
 * });
 * assertFields(customer, ['name', 'status']);
 * // customer.status is 'ok'; both values are present (still typed as Json).
 * console.log(customer.data.name, customer.data.status);
 * ```
 */
export function assertFields<
  R extends FieldResult,
  const F extends readonly (keyof ResultData<R> & string)[],
>(
  result: R,
  fields: F,
): asserts result is R & {
  readonly status: 'ok';
  readonly data: PresentFields<ResultData<R>, F>;
} {
  if (result.status !== 'ok') throw new ReadError('incomplete');

  for (const field of fields) {
    if (
      !Object.hasOwn(result.data, field) ||
      (result.data as Record<string, unknown>)[field] === undefined
    )
      throw new ReadError('incomplete');
  }
}
