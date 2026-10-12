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
[`relate/consumer`](../relate/CONTRACT.md#pagination) handles this contract.
Graph queries and traversals supply authorized pages over existing graph
membership; they do not enumerate provider-wide records.

## Discovery

`GraphDescription`, `ObjectDescription`, `ActionDescription` and their summaries
are the metadata one actor may see about a graph: readable object types, their
authorized properties and traversals, executable actions and the SDK-owned
`OperationContracts` that say how to call each read. Every scalar is reported as
a `ScalarSchema`; `relate/model` validates compiled manifests against that same
shape, so discovery never invents a constraint the compiler did not record.

`Discovery` is the actor-bound interface: `describe()`, `describeObject(id)` and
`describeAction(id)`. It is a pure function of one actor snapshot and the
installed model, so a remote consumer can fetch it once and bind it
synchronously. Undefined detail means the actor may not see that definition; a
listed capability is one the runtime will attempt, and record-level policy still
decides each result.

## Consumer operations

`ConsumerOperations` is the boundary every consumer surface shares. It is bound
to one authenticated actor and addressed by definition IDs:

```ts
interface ConsumerOperations {
  readonly discovery: Discovery;
  get(objectDefinitionId, objectId, request?): Promise<ObjectResult>;
  query(objectDefinitionId, request?): Promise<Page<ObjectRecord>>;
  traverse(
    objectDefinitionId,
    objectId,
    traversal,
    request?,
  ): Promise<ObjectResult | Page<ObjectRecord>>;
  invoke(actionDefinitionId, { input, idempotencyKey }): Promise<ActionReceipt>;
  getReceipt(actionDefinitionId, invocationId): Promise<ActionReceipt>;
}
```

The embedded engine implements it (`relate.operations(principal)` in
`@relate/node`), the planned `@relate/http` serves it, the planned
`@relate/client` implements it over a transport, and the typed facade in
`relate/consumer` turns it into `objects.Customer.get(...)` calls. Invariants
every implementation keeps:

- Authorization belongs to the implementation. A hidden record, traversal or
  action is indistinguishable from a missing one.
- Requests arrive unvalidated. Malformed requests reject with
  `ReadError('invalid-request')` or `ActionError('invalid')`; the facade adds no
  validation of its own.
- Every result is the complete public shape. `get` returns an `ObjectResult`
  with the canonical `id`, whatever the engine's internal envelope looks like. A
  to-one `traverse` returns an `ObjectResult`, a to-many `traverse` returns one
  `Page`; the facade rejects a result of the wrong shape.
- `discovery` is synchronous. A transport fetches the actor's snapshot before
  binding operations rather than making every `describe()` call asynchronous.
  The snapshot must belong to the same authenticated identity and model as the
  operations. `GraphDescription.definitionRevision` names that model and matches
  successful records' `meta.definitionRevision`. `not-found`, empty pages and
  action receipts do not carry a record revision. Remote implementations must
  enforce the bound model before executing every request, including actions; a
  stale snapshot alone cannot enforce this. HTTP pinning is not implemented.
  Refreshing discovery cannot repair generated types. Rebind a compatible
  client; do not automatically replay mutations after a model mismatch.
- Async methods reject their promises on failure, including validation and
  lifecycle failures. Transport implementations decode and validate results at
  their response boundary before exposing this interface; TypeScript types do
  not validate received JSON.

## Compact evidence

Reads default to compact evidence; pass `evidence: 'full'` for every selected
field's provenance. Values and access rules are identical in both modes.

See
[Read Responses & Evidence](../../apps/docs/content/reference/read-responses.md)
for the complete reference.
