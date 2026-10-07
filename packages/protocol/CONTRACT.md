# @relate/protocol contract

Detailed behavior of the current slice. For an overview of the package, see
[README.md](./README.md).

Transport-neutral Customer read requests, results, evidence, and errors. Private
and unpublished. No runtime, database, or provider dependencies.

Results distinguish `not-found` from `ok`, then represent each requested field
as `available`, `absent` (a known optional value), `forbidden`, or
`unavailable`. An explicitly selected known field denied by its field group has
only `{ status: 'forbidden' }`. Unknown fields and values that cannot be
supplied (such as stale values omitted after refresh failure) have only
`{ status: 'unavailable' }`. Neither status includes private policy, source, or
freshness evidence. Null remains a legitimate available value. Data is a partial
JSON record, never typed as a complete model.

Whole-object denial remains `not-found`. An otherwise readable reference field
whose target cannot be disclosed remains `unavailable`, without revealing
whether the target is missing or denied. Default selection includes only
permitted fields; it does not enumerate forbidden fields.

Both `forbidden` and `unavailable` make an explicit selection `partial` and
cause `requireComplete: true` to throw `ReadError('incomplete')`.
Permission-only omissions do not set `degraded`: a partial result can have
`degraded: false`. Unavailable fields, stale evidence, failed refresh, or
retention/ordering warnings still set `degraded: true`.

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
