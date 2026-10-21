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
errors or aliases. The MCP adapter is implemented; the standalone HTTP adapter
remains planned.

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

`GraphDescription` is a complete compact overview: graph identity/revision,
optional description, `objects` and `actions` maps keyed by API name, and a
shared `SdkDescription`. `ObjectOverview` contains an optional description and
named `TraversalOverview` entries (target API name, cardinality, optional
description). `ActionOverview` contains an optional description and readable
created-object API names. Both target and created names refer to entries in the
visible objects map. No search, truncation or pagination is applied.

`ObjectDescription` and `ActionDescription` retain full identity, display
metadata, authorized properties, traversals and action schemas. SDK options
carry `SdkOptionDescription` (`description` and accepted `ReadOperation` kinds),
so applicability is transport data, not inferred from prose. `sdk.errors`
explains read failures and how to inspect request issues. Full read-contract
types (`OperationContract`, `OperationContracts`) belong to `@relate/runtime`,
not this transport. Ordinary fields use `ScalarSchema`; `relate/model` validates
compiled manifests against that same shape. Declared calculations use
`ComputedPropertyDescription` with `kind: 'computed'`, an inferred logical
`ComputedResultType` schema, and `readable` for static dependency access. Their
SQL is never included. A property denied by its own field group is omitted.

Optional `datasets` maps declared association names to `DatasetDescription`.
Association gates determine presence; denied columns remain listed with
`readable: false`. Descriptions, stable IDs, logical types, nullability and
timestamp precision survive. Correlation text uses quoted declared names and is
omitted if it would name a hidden object property. Physical resource identifiers
and binding details never appear. Optional `compute` explains SQL syntax,
encoding, freshness and the currently supported read modes. Computed
`filterOperators` remains empty until computed filtering is implemented.

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
- A binding pinned to a runtime that has been replaced rejects with
  `ReadError('runtime-retired')` or `ActionError('runtime-retired')`. The
  request did not execute and is never redirected to, or replayed on, the
  replacement runtime. This is distinct from a denial (`not-found`, `denied`)
  and from temporary unavailability (`unavailable`): retrying the same binding
  cannot succeed, so the caller rebinds first.
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

## Activity records

`activity.ts` defines the transport-safe activity contract: `Operation` (one
attempt: `get`, `query`, `traverse`, `invoke`, `receipt`, `adopt` or `refresh`),
`Change` and `InvocationEvent` (together `FeedEntry`, one publication order),
`ObjectProvenance`, `OperationContext`, filters, `ActivityPage` and
`ActivityStatus`. Records carry metadata, stable definition IDs and typed object
references only, never property values, filter values, action inputs/outputs or
raw errors.

Each union constrains its variant: only `invoke` has `replayed`, a terminal
invocation outcome always has an `invocationId`, only `refresh` has a refresh
result, and only `query` and `traverse` successes have `hasMore`. `Change.kind`
`created` never has a `sourceDefinitionId`; `adopted` and source-refresh changes
always do, and source-refresh changes have the source as actor with
`triggeredBy` naming the principal or system actor whose operation observed
them. Schema versions are independent of graph revisions; consumers skip unknown
kinds or versions while advancing their checkpoint.

`ActivityPage.nextCursor` is opaque and advances over the scanned range even
when no entry matched, unlike `Page<T>`. `ActivityError` codes are `unsupported`
(never an empty history), `unavailable`, `invalid-request`, `invalid-cursor` and
`cursor-expired`.
