# @relate/protocol contract

Detailed behavior of the current slice. For an overview of the package, see
[README.md](./README.md).

Transport-neutral Customer read requests, results, evidence, and errors. Private
and unpublished. No runtime, database, or provider dependencies.

Results distinguish `not-found` from `ok`, then represent each requested field
as available, absent (a known optional value), forbidden, or unavailable. Null
remains a legitimate available value. Data is a partial JSON record, never typed
as a complete model.

## Withheld fields

```ts
// Ana selects a known financial field her roles do not grant.
fields.revenue = { status: 'forbidden' };

// Fin may read it, but refresh failed and stale values were omitted.
fields.revenue = { status: 'unavailable' };
```

`forbidden` means the field is known and the caller's roles do not grant its
access group. It is a final answer for that principal: refreshing or retrying
cannot change it. It discloses only the caller's own role membership, which the
caller already knows, never object-level policy evidence or values.

`unavailable` means the caller may read the field, but no value could be
supplied: an unknown name, a stale value omitted by `stale: 'omit'`, or a
reference whose target cannot be disclosed. Hidden and deleted reference targets
share this shape, so the response does not reveal which applies.

Whole-object denial, including failed `where` conditions, stays `not-found` and
never reaches field evidence.

Both withheld shapes make the selection `partial`, and `requireComplete: true`
rejects either. Only `unavailable` sets `degraded: true`: a forbidden field is
correct for its caller, not a lower-quality read.

Completeness, freshness, and durability are independent. Evidence reports source
identity only for authorized exposed values and never includes raw provider
errors or aliases. HTTP and MCP adapters are not implemented in this slice.

Field evidence separates the retention outcome from `retentionDurability`:
`volatile` for memory and `persistent` for storage that survives process
restart. A confirmed retention outcome alone is not a persistence guarantee.

Consumer-side presence checking lives in `relate`. See
[`assertFields`](../relate/CONTRACT.md#require-values-after-a-read) for its
value checks and TypeScript narrowing contract.

## Pages

`Page<T>` preserves each record's data and evidence in `data`. Its `meta` is a
`PageMeta` discriminated union: `{ exhausted: true }` omits the continuation,
while `{ exhausted: false, continuationCursor: string }` requires one. Types
also reject a cursor on the exhausted variant. Runtime validation rejects empty
tokens and contradictory metadata; these types alone do not validate JSON.

An empty page can have a continuation. Consumers must follow exhaustion, not
record count. The implemented pagination helper in
[`@relate/runtime`](../runtime/CONTRACT.md#pagination) handles this contract;
collection query execution remains unimplemented.
