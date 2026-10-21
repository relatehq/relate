# Writing a store

Implement `ObservationStore` from `@relate/runtime/storage` and pass your
instance as `createRuntime({ model, graphId, sources, store })`. The runtime
handles source fetching, validation and authorization; a store handles identity,
ordering and retention. A store must not perform source I/O or decide caller
permissions.

```ts
import type { ObservationStore } from '@relate/runtime/storage';
import {
  compareObservation,
  OrderingConflict,
  RetentionError,
} from '@relate/runtime/storage';
```

The base interface is the source-observation contract. The optional `native`
capability supplies native transactions; source-only adapters remain valid for
read-only applications. The optional `activity` capability supplies the durable
feed and best-effort operation history (see [Activity](#activity-capability)).
Object provenance is part of the base and native contracts, not of activity.
History querying and consumer receipt lookup are separate.

## Property identity

`Observation.values` and `NativeRecord.values` are keyed by stable property
**definition IDs**, including references. For example, the public `name` field
with ID `business.customer.name` is retained as:

```json
{ "business.customer.name": "Mothlight" }
```

`Observation.raw` retains provider field names. Consumer data and field evidence
use the current API property names; only projection translates IDs to names.
Authorization and reference lookup read ID-keyed values directly. Adapters must
preserve these keys in snapshots and any value history they retain.

Manifest format 3 establishes this storage contract. Recompilation changes the
definition revision, so existing format-2 installations reject activation of the
new model. Neither built-in store guesses whether a key is a name or an ID.
Existing observations and Postgres value history require an explicit migration
using the old pinned model's name-to-ID mapping before revision activation;
model/data migration tooling is not implemented. Do not change the stored
revision alone. `migrate()` only applies physical schema migrations and does not
convert graph data. Before refreshing or projecting a retained observation, the
runtime rejects value keys that are not property IDs of that object with
`Stored observation values must use property IDs; explicit migration required`.
This check also runs before evaluating the object's read policy, so a
revision-only change cannot silently turn legacy values into absent fields or a
policy denial. Native records already used property IDs.

## Methods and guarantees

| Member                                 | Required behavior                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durability`                           | `volatile` for process-local storage; `persistent` when acknowledged retention survives normal client/process restart. This declares a storage guarantee, not the outcome of an individual write.                                                                                                                     |
| `install(graphId, definitionRevision)` | Atomically pin a graph instance to its revision. Repeating the same installation succeeds. A different revision rejects without replacing the installed revision.                                                                                                                                                     |
| `beginFetch()`                         | Allocate a unique, increasing integer encoded as a decimal string. Tokens must be comparable across every client sharing retained data, including after reconnect/restart for persistent stores. Gaps are allowed. Allocate before source I/O; do not use response arrival time.                                      |
| `load(scope, objectId)`                | Return the latest accepted whole object in precisely this scope and revision, or `undefined` if absent/mismatched. Operational failures reject; they must not masquerade as absence.                                                                                                                                  |
| `resolve(scope, sourceRecordId)`       | Return an existing identity and its latest observation in the exact scope/revision, or `undefined`. Never adopt, fetch, or create an alias. Preserve tombstones; the runtime decides readability. Failures reject.                                                                                                    |
| `scan(scope, { after, limit })`        | Enumerate adopted identities (including tombstones) in the exact scope/revision, ordered lexically by opaque `objectId`. `after` is exclusive. Return at most `limit` independent snapshots and `hasMore`; reject limits outside integer 1–100. Never fetch, adopt, filter by caller access, or skip unknown records. |
| `accept(scope, input)`                 | Atomically check installation and membership, compare ordering, and retain the winning whole observation and identity. Return `{ object, acceptance, change? }`, including the current winner when the incoming observation loses. `change` is present exactly when this acceptance changed business state.           |
| `provenance(scope, objectId)`          | Return adoption provenance from the object's own row: `{ kind: 'adopted', actor, at, sourceDefinitionId }`, `{ kind: 'unknown' }` for identities stored without it, or `undefined` when the object is absent. Never read activity or receipts. Failures reject.                                                       |

Every operation is scoped by installed graph ID/revision, object definition,
source definition, connection ID, provider account identity and authorization
partition. `StorageScope.providerAccountId` is a nonempty string for verified
accounts and `null` for application-owned connections. Null is an intentional
identity mode, not missing or unknown evidence: it must remain distinct from all
verified accounts and legacy observations with unknown provenance. No data may
cross these boundaries. Only `shared-service` is supported today.

`accept` must serialize competing writes to the same scoped `sourceRecordId`,
including simultaneous first adoptions. When `adopt` is true it may allocate a
new nonempty, opaque string `objectId`; repeated adoption reuses that ID. IDs
must be unique within the scope. When `adopt` is false, existing membership is
required. If `input.objectId` is supplied it must match that source alias.
Deletion retains the identity and a tombstone observation.

Use the exported `compareObservation(previous, incoming)` inside the atomic
operation. It compares source versions before fetch-start tokens and returns:

- `changed`: replace the retained observation.
- `unchanged`: replace it too, advancing observation time and ordering evidence.
- `superseded` or `replay`: preserve the existing observation and return it.

For a winning `changed` or `unchanged` acceptance, call the exported
`describeAcceptedChange(previous, accepted)` under the same lock, with the
locked previous observation. It returns `adopted` for first membership,
`deleted` and `restored` for state transitions (with no properties), `updated`
with the sorted IDs of changed or removed mapped properties, or `undefined` when
mapped values and state are unchanged, including raw-only provider differences.
Do not call it for `superseded` or `replay`, and never derive a change from
`Acceptance` alone or from a diff outside the lock. Return
`{ id: input.attribution.changeId, ...classification }` as `change`.

`input.attribution` is trusted runtime provenance: the adopting or triggering
actor, operation and parent operation IDs, request context, occurrence time and
a preassigned change ID. On first membership, persist the actor and occurrence
time as adoption provenance with the identity, whether or not the store supports
activity. When it does, record the change as a feed entry built with
`sourceChangeDraft(scope, objectId, attribution, change)` in the same atomic
operation. Failure to record a required change fails the acceptance with the
existing `RetentionError` contract. Any value history the adapter records uses
the same classification, so a raw-only acceptance writes neither.

Propagate `OrderingConflict` without changing state. Never commit the raw
record, mapped values, observation time or ordering token separately. If an
adapter also records history, commit that history in the same transaction.
History querying is not part of this interface; Postgres currently records value
changes as an adapter feature, while the memory store retains only the latest
observation.

Inputs and returned objects must not expose mutable references to retained
state. Load, resolution, scan and acceptance results are independent snapshots.
Reads after a successful acceptance must observe that write or a later accepted
winner.

## Failure and lifecycle

Reject `accept` with `RetentionError('failed', { cause })` when you know nothing
was committed. Use `RetentionError('unconfirmed', { cause })` when a commit may
have succeeded, such as a lost acknowledgement. The runtime may read back to
resolve uncertainty. Do not return success for a queued, incomplete write. An
ordering conflict is a distinct error and must remain distinguishable.

`retention: 'confirmed'` in field evidence means this store accepted the value.
`retentionDurability` reports the store's guarantee separately: `volatile` does
not survive losing the store instance; `persistent` survives normal process
restart. A failed/unconfirmed write is not made durable by that capability.
Neither capability promises backup, disaster recovery or infinite retention.

The host owns adapter setup and shutdown. For example, it calls Postgres
`migrate()` before use and `close()` afterward. The runtime does not close a
supplied store because it may be shared. The default memory store is isolated
per runtime; an explicit `createMemoryStore()` can be shared by several
runtimes. It needs no migration or close method and is released when no longer
referenced.

## Verification

The reusable suite in `tests/support/store-contract.ts` runs against memory and
Postgres. Use it as the starting point for an adapter's conformance tests. It
checks revision/scope isolation, atomic concurrent adoption, membership checks,
ordering, tombstones, refreshed evidence and snapshot isolation. Add tests for
your adapter's transactions, multiple clients, restart behavior and ambiguous
commit outcomes. Interface compatibility alone does not establish correctness.

## Native write capability

`ObservationStore.native?: NativeStore` uses installed graph/revision scope.
`load` returns a native record by object type and canonical ID; `loadInvocation`
returns trusted storage evidence by action/key. These are host/runtime storage
operations, not caller-authorized receipt APIs. Never expose them through a
consumer or transport directly.

`transaction(scope, callback)` gives the runtime `load`, `scan`, `insert`,
`claim`, `findInvocation`, `saveInvocation`, `savepoint` and, with activity,
`appendFeed`. Reads see the transaction's writes; independent readers do not see
uncommitted records. Commit every insert and invocation receipt together only
after the callback succeeds. Any callback error rolls back both native effects
and the key reservation. Reject unfinished claims. Invalidate the transaction
handle before awaiting rollback and after completion; never expose mutable
storage references.

The runtime can reject the callback at its execution deadline even while handler
code or object operations are still suspended. Roll back and release graph locks
and pool slots without waiting for that code to finish; reject any later calls
through its retained transaction handle. A connection failure must also
interrupt a suspended callback and release its resources. Race cancellation only
before COMMIT; after COMMIT is sent, preserve confirmed versus uncertain
outcomes.

`claim` atomically reserves a new graph/action/key and returns `undefined`, or
returns an isolated snapshot of the original committed invocation. Concurrent
claimants must observe the winner after its commit, never execute twice. A
reservation whose transaction rolls back is retryable. `findInvocation` looks up
an invocation by action and invocation ID in the transaction's graph/revision;
missing and wrong-action IDs return `undefined`. Neither operation authorizes
receipt disclosure. Runtime checks actor, input and current access.

`insert(record, creation)` stores creation provenance (the creating actor and
invocation ID) on the object row in the same write, alongside `createdAt`, even
when the store does not support activity. `NativeStore.provenance(scope, ref)`
reads it back as `{ kind: 'created', actor, at, invocationId }` with `at` from
the object's own `createdAt`; never join receipts. Legacy rows return
`{ kind: 'unknown' }` and absent objects `undefined`.

Save validated input, originating actor ID, terminal receipt and runtime read
dependencies under the new claim. The runtime also supplies the attempt's actor
kind, operation ID, request ID, transport, definition revision and start and
completion times; persist them, and return null for legacy invocations. Read
dependencies use stable object/property definition IDs and canonical record IDs.
Legacy actor/read provenance is null: preserve that evidence and its key, never
infer ownership or make the key reusable. Key expiry and receipt-detail
retention are separate future capabilities. Native record values use stable
property definition IDs. The runtime owns value, reference and permission
validation; adapters own isolation and atomicity.

Only known rollback can be treated as a confirmed failure. A lost commit
acknowledgement raises `NativeCommitUncertain`; do not automatically retry it.
Use `StorageUnavailable({ cause })` for recognized temporary storage failures
during installation or before native commit, or after a confirmed transaction
rejection. Never use it for an ambiguous COMMIT. The action executor maps this
and `ReadError('unavailable')` to sanitized `ActionError('unavailable')`;
unknown errors remain `internal`. Adapter-specific connection and timeout
classification belongs in the adapter, not the runtime.

Source observation refreshes remain independent of this transaction. The shared
`tests/support/native-action-contract.ts` suite verifies native behavior on
memory and Postgres, including failure after insert but before receipt save.

`savepoint(callback)` must roll back every change made by its callback on
rejection, including any nested key claims, while retaining the outer
transaction and its earlier claim. Successful callbacks keep their changes. The
executor uses this to roll back native effects of a declared business failure
and then save its failed receipt in the same outer transaction. A savepoint is
not an independent commit. Adapters must preserve callback errors; rollback
failures reject the whole transaction. Deadline revocation also guards
savepoints and prevents late handler activity from committing.

### Native enumeration

`NativeStore.scan(scope, type, { after?, limit })` and
`NativeTransaction.scan(type, { after?, limit })` return isolated native records
in strictly ascending canonical object-ID order, plus `hasMore`. Return at most
`limit` records, excluding the `after` boundary; use bytewise ordering for the
ASCII runtime-generated IDs (Postgres uses `COLLATE "C"`). Never cross graph,
revision or object-type boundaries. An empty batch must have `hasMore: false`.

Transaction scans see earlier inserts, honor savepoint rollback, and reject
calls after transaction revocation just like `load`. Independent scans see only
committed state. Scanning does not authorize records or apply caller predicates;
the runtime composes it with its existing authorized reads.

## Activity capability

`ObservationStore.activity?: ActivityStore` records the feed (changes and
invocation events) and best-effort operations. A store that advertises it must
record feed entries atomically for every write capability it exposes, and say so
in `atomicFeed: { sourceAcceptance, nativeTransactions }`. Runtime setup rejects
a store that advertises activity without covering its native capability. A
standalone best-effort sink cannot advertise activity. Feed entries have the
durability of the owning store.

### Atomic feed recording

`NativeTransaction.appendFeed(drafts)` stages ordered drafts. Staging follows
savepoint rollback and handle revocation and does not take the publication lock.
After the callback succeeds, publish the staged batch as the final work before
COMMIT: assign positions, set `recordedAt`, and write every entry, with no user
callback or provider I/O under the publication lock. Source acceptance publishes
through the same path. If publication fails, nothing commits.

Positions must become visible in allocation order: no earlier position may
become visible after a later committed position has been returned. Postgres
allocates from a per-graph counter row held until COMMIT; a bare sequence or
UUID ordering is not sufficient. Memory publishes in its synchronous commit
section. A batch the retained limits cannot hold rejects its write before
publication; eviction never discards part of a newly committed batch.

Validate drafts at the write boundary with `validateFeedDraft`, which rejects
incomplete references, cross-variant fields and invalid source/trigger
attribution. Store only `executionId`, `runtimeId` and `initiator` as context
metadata; request ID and transport are typed fields.

### Operations

`appendOperations(graphId, drafts)` is called by the runtime's single writer,
never inside a domain transaction. Validate with `validateOperationDraft`.
Appends are first-write-wins by `(graphId, id)`, within and across batches:
insert each new operation with all its lineage atomically, preserve lineage
order, and never amend or mix lineage of an existing ID. Bound I/O; best-effort
appends must not consume resources committed writes need.

### Reading

`feed.read(graphId, options)` returns retained entries oldest first, up to a
committed high-water mark captured in one consistent snapshot with the retention
floor. `operations.list(graphId, options)` returns operations newest first by
`(recordedAt, id)`. Use `feedReadOptions` and `operationReadOptions` to validate
options and decode cursors, `matchesFeedEntry` and `matchesOperation` for filter
semantics, and `encodeActivityCursor` for `nextCursor`. Cursors bind graph,
method and, for the feed, stream identity. A feed cursor behind the retention
floor or from another stream rejects with `ActivityError('cursor-expired')`;
never skip entries silently.

`tests/support/activity-contract.ts` verifies these guarantees on memory and
Postgres.

### Resource identity

Source scopes include both `connectionId` and `resourceId`. Rebinding a source
to another table or API resource on the same connection cannot reuse its
previous membership, observation, provenance or continuation cursor. Memory and
Postgres stores enforce the same scope on load, resolve, scan and acceptance.
