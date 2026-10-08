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
`not-found`, with no field or policy evidence. These paths share the summary
rule in `src/reads/evidence.ts`.

A deleted reference target does not delete a referring native object or clear
its stored link. Reads withhold the unresolved reference with
`status: 'unavailable'` field evidence; other fields remain readable when the
object's own policy permits it. See
[deleted references and future deletion policies](../node/NATIVE_ACTIONS.md#references-after-a-target-is-deleted)
for the Task example, future edit rules, and deferred opt-in cascading deletes.

Each source identity check and record fetch wait defaults to 3 seconds (maximum
10 seconds), including non-cooperative connectors. The Postgres adapter
separately bounds pool, lock, and statement waits; this is not a whole-request
deadline guarantee. Connectors must honor cancellation to stop their own
outstanding I/O. Each read uses at most one source fetch in this slice.

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
check for the individual record. Applications requiring that check must request
refresh of source-backed fields. Record-fetch errors remain temporary
unavailability with authorized fallback subject to the binding’s identity mode
and current Relate policy evidence.

Provider-verified bindings require an expected `providerAccountId` alongside
`connectionId`. `SourceConnector.identify({ signal })` authenticates current
credentials and returns the provider's stable account ID. It must not echo
configuration or reuse identity evidence after credentials change. The runtime
checks identity before using cached source observations and again before
disclosure after asynchronous work. Identity mismatch or explicit denial
withholds the object; failed or timed out verification raises sanitized
`ReadError('unavailable')`, without fallback. Every `SourceRecord`, including
deletion, must carry `providerAccountId` from the authenticated response or the
immutable credential context that fetched it. Missing or mismatched response
identity withholds the result without retention or stale fallback. Never stamp
the expected binding ID onto an unverified response. Connectors remain a trusted
integration boundary.

Application-owned connectors implement `ApplicationSourceConnector` with
`identity: 'application'`, `fetch()`, and no `identify()`. Bindings and results
omit `providerAccountId`. The host owns the logical source identity through
`connectionId`: relocation of the same source preserves it; replacement with a
different logical source requires a new ID. The runtime does not authenticate a
provider account in this mode and cannot detect substitution under the same ID.
Never emulate verification by returning a configured label from `identify()`.
Policy checks, record denial, freshness and deletion evidence still apply. A
fresh cached read need not access the provider in application mode.

Storage scopes include provider account identity (`null` for application-owned
connections, distinct from every verified account and unknown legacy
provenance). Switching identity modes creates a separate scope and requires
adoption there. Changing accounts under the same connection ID creates a
separate alias and object ID when explicitly adopted. Existing object IDs,
reference resolution, scans and traversal cursors cannot cross account scopes.
Provider account IDs stay out of consumer evidence.

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
to-many traversals. The graph query engine below supplies authorized pages; the
helper itself does not implement filtering or action transactions.

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

## Graph queries

`runtime.query(principal, objectDefinitionId, request?)` returns one
`PageResult`. The Node consumer and action APIs expose
`objects.Invoice.query(options?)` as an awaitable, async-iterable `QueryResult`.
Portable request/result types live in `@relate/protocol`; typed `QueryOptions`
and object records live in `relate`.

- Omit `where` or pass `{}` to enumerate. Otherwise each property is an exact
  scalar equality test, combined with AND. Values must satisfy the property's
  compiled schema. References and object-ID properties use canonical Relate IDs.
  `null` matches explicit null; known absent optional values do not match. There
  is no `undefined` filter, nested predicate, comparison, sorting or
  aggregation.
- Membership is adopted source identities or native records in this graph and
  revision. Source queries may refresh known records through existing `get`
  behavior, but never discover/adopt provider records. Exhaustion describes this
  scan, not provider-wide coverage. Direct source queries and sync are planned.
- Validate filter names, values and field access before scanning, even if there
  are no records. Invalid or forbidden filters reject with `invalid-request`.
  Whole-object policies filter candidates before caller predicates. Missing or
  unavailable filter evidence on a readable candidate rejects with `incomplete`,
  rather than silently treating an unknown match as false. `stale: 'allow'` can
  match authorized stale values; `stale: 'omit'` cannot. Source
  denials/deletions follow the existing read path and do not resurrect retained
  data.
- Filter fields need not be selected and do not appear in projected results.
  `requireComplete` applies to the final selection of matching records. Records
  preserve field evidence, freshness and warnings from reads. Authorization and
  filter freshness are checked again before emitting pending matches.
- Ascending canonical object ID supplies deterministic keyset order. `limit`
  defaults to 25 and accepts integers 1–100; it is a maximum page size. Each
  page examines at most 100 candidates. Filtering and denial can yield short or
  empty non-final pages. Continue until `meta.exhausted`; no total count is
  reported.
- Encrypted cursors expire after 15 minutes and bind graph, revision, principal,
  object type, source bindings, filters, selection and read options/page size. A
  shared `cursorKey` allows continuation across trusted runtime instances.
  Action cursors additionally bind their transaction; they cannot escape it. The
  runtime checks actual scan progress, not just changing cursor strings.
- Pages are not a snapshot. Concurrent insertions before the cursor may be
  missed, later insertions may appear, and values/access may change between
  pages. Native queries within actions see earlier native writes in the same
  transaction; source observations do not join that transaction.
- Action queries use the executor's deadline and failure handling. A failed page
  aborts native effects even if its rejection is caught by the handler. Receipt
  dependencies include fields inspected while evaluating readable candidates,
  including filter-only fields and non-matches. Receipt replay checks current
  access to those dependencies; it does not rerun the query or promise the
  historical population still matches.

Shared acceptance cases in `tests/support/query-contract.ts` execute on memory
and Postgres. Type probes cover caller/action filters, reference IDs, selection
and iteration; installed-package smoke checks exercise graph query execution.

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
success or throws sanitized `ActionError`. `getReceipt` and matching-key replay
recover success under originating-actor and current-access checks, including the
handler's saved object/field read dependencies. They do not invoke the handler.
Durable pending execution and failed receipts remain subsequent slices. See
[receipt recovery](../node/NATIVE_ACTIONS.md#wait-for-completion-lookup-and-recovery).
