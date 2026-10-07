# @relate/runtime contract

Detailed behavior of the current slice. For an overview of the package, see
[README.md](./README.md).

Embedded read and native-action execution with explicit source and storage
contracts. Private and unpublished.

`createRuntime` composes a compiled model, installed graph ID, optional storage
adapter, source bindings and an optional clock. Consumer `read` applies
default-deny policy, field groups, selection, freshness and evidence. Trusted
host `adopt` fetches a known source record ID and durably establishes
membership. It is not a consumer-authorized creation action.

`@relate/runtime/storage` is the supported adapter extension boundary. Storage
owns atomic observation acceptance through `ObservationStore`; the runtime owns
the shared pure ordering rule. Concrete adapters are injected, never imported.
Modules separate authorization, observation validation/ordering and resolution.

Reads retain successful source observations. Retention failure can return a
validated authorized transient value with explicit durability/ordering warnings;
it cannot renew permission evidence. Provider versions precede fetch-start
ordering. Without provider versions, order is best effort and cannot prove
upstream recency. Deletion and denial are never undone by fallback.

An explicitly selected known field denied by its field group returns only
`{ status: 'forbidden' }`; unknown fields and omitted stale values remain
`{ status: 'unavailable' }`. Both make the selection partial and fail
`requireComplete`. Permission-only omission does not set `degraded`; unavailable
fields and freshness, refresh, retention or ordering problems still do. This
applies to source reads, native reads and traversal results. Default selection
continues to omit forbidden fields entirely. Whole-object denial remains
`not-found`, with no field or policy evidence.

A deleted reference target does not delete a referring native object or clear
its stored link. Reads withhold the unresolved reference with
`status: 'unavailable'` field evidence; other fields remain readable when the
object's own policy permits it. See
[deleted references and future deletion policies](../node/NATIVE_ACTIONS.md#references-after-a-target-is-deleted)
for the Task example, future edit rules, and deferred opt-in cascading deletes.

The source fetch wait defaults to 3 seconds (maximum 10 seconds), including
non-cooperative connectors. The Postgres adapter separately bounds pool, lock,
and statement waits; this is not a whole-request deadline guarantee. Connectors
must honor cancellation to stop their own outstanding I/O. Each read uses at
most one source fetch in this slice.

Only explicit shared service-account source bindings are supported. Delegated
credential partitions, automatic sync workers and arbitrary collection
predicates are not implemented. Source-backed traversal and synchronous native
actions are implemented; see
[native account reviews](../node/NATIVE_ACTIONS.md). Engine results remain
partial JSON records. `@relate/node` composes this engine with authored
definitions and provides typed `relate.as(principal).objects.Customer.get(...)`
reads.

Connectors throw `SourceAccessDenied` for an explicit provider permission
denial. The affected read returns `not-found` rather than falling back to
retained data. This is not a deletion or a persisted revocation: retained
observations remain, and a cached read does not perform a provider authorization
check. Applications requiring a current provider check must request refresh of
source-backed fields. Other connector errors remain temporary unavailability
with authorized fallback.

Use
[`assertFields` from `relate`](../relate/CONTRACT.md#require-values-after-a-read)
to require specific values on an existing result. It narrows an `ok` result and
the checked fields, preserves valid `null` and stale values, and throws
`ReadError('incomplete')` when required values are missing. Other fields and the
read's evidence stay unchanged; freshness remains a separate requirement.

## Storage

Omit `store` for an isolated in-memory store with no database setup:

```ts
const runtime = createRuntime({ model, graphId, sources });
```

Supply `createMemoryStore()` from `@relate/runtime` to share memory between
runtimes, or a Postgres/custom `ObservationStore` for persistent retention.
Memory supports the same identity, ordering, authorization and fallback behavior
within its lifetime. It does not retain data across process restarts.

Field evidence separates write outcome (`retention`) from storage guarantee
(`retentionDurability: 'volatile' | 'persistent'`). Both built-in stores run the
same conformance suite. `pnpm test:unit` runs the memory and pure unit tests
without Postgres.

See [Writing a store](STORE_CONTRACT.md) for the public interface's behavioral
contract, errors, lifecycle and adapter verification requirements.

## Pagination

`createQuery(readPage, { cursor? })` wraps an authorized page reader in a
`QueryResult<T>`. Await the handle to obtain one `Page<T>`; use `for await` to
iterate records across pages. This is implemented infrastructure for queries and
to-many traversals. Collection query execution remains separate; the helper does
not implement a query engine or action transactions.

```ts
import { createQuery } from '@relate/runtime';
import type { Page } from '@relate/protocol';

// An operation supplies its authorized reader, bound to query options/context.
declare const readPage: (cursor: string | undefined) => Promise<Page<Invoice>>;
const query = createQuery(readPage);
const page = await query; // One page; page.data remains available.

for await (const invoice of query) {
  // Each record, including its evidence, passes through unchanged.
}
```

Execution is lazy. The first page request and any failure are shared across
awaits and iterators on the same handle. Each iterator has independent
continuation state; later pages are fetched on demand and may be fetched again
on reiteration. There is no prefetch: `break` or a thrown business error stops
further page requests. The handle supports `await`/`then` and async iteration,
not the full `Promise` API.

The helper validates each page before exposing its records. Missing, empty,
contradictory or unchanged continuations throw `ReadError('incomplete')`, as do
cursor cycles within an iterator. Empty non-final pages are followed. Reader
failures propagate unchanged; the reader must already sanitize errors and
validate/authorize records. No operation is retried or committed by this helper.
Separate explicit-page handles only know their own request cursor, not the
history of earlier independent requests.

The page reader owns stable query/context binding, real scan progress, cursor
scope, ordering, resource budgets and cancellation of its I/O. Different opaque
tokens cannot prove progress or snapshot consistency. This helper introduces no
cross-source snapshot or automatic native rollback; those belong to the query
engine and action transaction owner. Page size and an application's total work
bound remain separate.

## Native actions

`invoke` runs a compiled action through its registered handler and optional
`store.native` transaction capability. Runtime owns action gates, input/output
validation, authorized get/create, reference membership, abort tracking and
final create-policy validation. Successful native effects and receipt evidence
commit atomically. `@relate/node` binds typed implementations and caller
methods; it does not own transaction or authorization semantics.

`actionTimeoutMs` bounds the native callback after lock acquisition: 60,000 ms
by default, with host-configured integer values from 1 to 60,000. Expiry revokes
object/native transaction access and rejects the callback so the adapter rolls
back and releases its resources even if the handler never returns. Late handler
completion cannot save a receipt or commit. This budget ends before COMMIT and
does not include installation, lock/pool waiting or database cleanup.

Memory serializes native transactions per graph using isolated working copies;
Postgres provides the same behavior with adapter-owned transactions. Source
observation retention stays separate. Current execution returns confirmed
success or throws sanitized `ActionError`; durable pending execution and
consumer receipt lookup/replay are subsequent slices.
