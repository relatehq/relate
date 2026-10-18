# Activity & Provenance

Relate keeps one shared account of what happens in a graph, so trusted host code
can answer three questions without reconstructing a timeline from domain tables:

- **What did someone attempt?** An _operation_: one read, query, traversal,
  action invocation, receipt lookup, adoption or source refresh, by one actor,
  with its outcome and the objects it touched.
- **What actually changed?** A _change_: an object created by an action, adopted
  from a source, or updated, deleted or restored in its source, committed
  atomically with the state it describes.
- **Which actions finished?** An _invocation event_: an action invocation that
  reached a durable receipt, committed atomically with that receipt.

Changes and invocation events form the **feed**, one stable publication order
that integrations can follow. Operations are best-effort diagnostic history.

Activity records carry metadata and stable definition IDs only, never property
values, filter values, action inputs or outputs, or raw errors.

These APIs are trusted host APIs. They are not part of `as(user)`,
`ConsumerOperations`, MCP tools or any consumer transport.

---

## 1. Following the Feed

`runtime.host.activity.feed.read` returns feed entries oldest first, starting
from the retained beginning. Save `nextCursor` after processing a page and
resume from it later:

```ts
let cursor = await loadCheckpoint();

for (;;) {
  const batch = await runtime.host.activity.feed.read(
    cursor ? { cursor, limit: 100 } : { limit: 100 },
  );

  for (const entry of batch.entries) await processIdempotently(entry);

  cursor = batch.nextCursor;
  await saveCheckpoint(cursor);

  if (!batch.hasMore) break;
}
```

A page reads up to the newest committed entry at the time of the call; poll
again to follow new entries. `nextCursor` advances past every scanned entry,
including filtered-out ones, so an empty filtered page can still move the
checkpoint. Re-reading a checkpoint can return entries again: deduplicate by
entry `id` and save the checkpoint only after processing succeeds.

Filters are supplied when beginning a sequence and stored in the cursor:

```ts
const reviews = await runtime.host.activity.feed.read({
  filter: { kinds: ['created'], objectDefinitionId: 'business.account-review' },
});
const next = await runtime.host.activity.feed.read({
  cursor: reviews.nextCursor,
});
```

Supplying both a `cursor` and a `filter` rejects as `invalid-request`. Limits
default to 50 and range from 1 to 500.

### Feed entries

```ts
// Ana adds a review: one change and one invocation event, same transaction.
{ kind: 'created', position: '41',
  object: { objectDefinitionId: 'business.account-review', objectId: 'rev_01' },
  changedPropertyIds: ['review.author', 'review.customer', 'review.note'],
  invocationId: 'inv_a1', operationId: 'op_02',
  actor: { kind: 'principal', id: 'ana' }, context: { requestId: 'req_a2', transport: 'embedded' }, … }
{ kind: 'invocation-succeeded', position: '42',
  actionDefinitionId: 'business.add-account-review', invocationId: 'inv_a1', … }

// Fin's read finds the CRM record renamed and refreshes it.
{ kind: 'updated', position: '43',
  object: { objectDefinitionId: 'business.customer', objectId: 'cus_01' },
  changedPropertyIds: ['customer.name'], sourceDefinitionId: 'crm.customers',
  actor: { kind: 'source', id: 'crm.customers' },
  triggeredBy: { kind: 'principal', id: 'fin' },
  operationId: 'op_05', parentOperationId: 'op_04', … }
```

| Kind                   | Meaning                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `created`              | An action created a Relate-owned object                         |
| `adopted`              | A source record first entered the graph                         |
| `updated`              | A source record's mapped values changed                         |
| `deleted`, `restored`  | A source record was deleted, or reappeared after deletion       |
| `invocation-succeeded` | An action invocation reached a succeeded receipt                |
| `invocation-failed`    | An action invocation reached a declared failure (`failureCode`) |

A source change says when Relate observed it, not when or by whom the provider
made it. Its actor is the source; `triggeredBy` names whose operation led Relate
to look. A raw provider field change that leaves mapped values unchanged
produces no change.

Object filters match direct references only. A review created for a customer
references the review, so a filter for the customer does not return it.

---

## 2. Browsing Operations

`runtime.host.activity.operations.list` returns operations newest first:

```ts
const page = await runtime.host.activity.operations.list({
  filter: {
    object: { objectDefinitionId: 'business.customer', objectId: 'cus_01' },
  },
});
```

```ts
{ id: 'op_01', kind: 'traverse', definitionId: 'business.invoice',
  actor: { kind: 'principal', id: 'ana' }, outcome: { status: 'ok' },
  details: { traversalId: 'business.customer-invoices', from: { … }, hasMore: false },
  objects: [
    { objectDefinitionId: 'business.customer', objectId: 'cus_01', role: 'traversal-origin', returned: [], forbidden: [], unavailable: [] },
    { objectDefinitionId: 'business.invoice', objectId: 'inv_01', role: 'returned',
      returned: ['invoice.status'], forbidden: ['invoice.total'], unavailable: [] },
  ], … }
```

`objects` is the operation's lineage: requested targets, returned records and
traversal origins, in result order, with the stable property IDs each actor
actually received or was refused. A source refresh triggered by a read is its
own `refresh` operation with `parentOperationId` set to the read; an
`operationId` filter returns an operation and the operations nested under it.

Each call is its own operation with a fresh ID; a retried action invocation is a
new operation that replays the saved receipt (`replayed: true`). Embedded calls
get a fresh request ID per call. A transport can bind request context for every
call it makes on behalf of one request:

```ts
const operations = runtime.operations(principal, {
  requestId: request.headers['x-request-id'],
  transport: 'http',
});
```

Bind `transport` in every transport host (`'mcp'` for an MCP `bindGraph`,
`'http'` for an HTTP API). Calls bound without it are recorded as `'embedded'`.

Operation rows are recorded after each operation settles through a bounded
queue. Recording never fails or delays the caller's operation, and rows can be
missing, for example after queue overflow or a failed append. A missing row is
not evidence that an operation did not happen. Feed entries do not depend on
operation rows: each carries its own actor, context and operation ID.

---

## 3. Object Provenance

Who created or adopted an object is stored on the object itself, independently
of feed or operation retention:

```ts
await runtime.host.provenance({
  objectDefinitionId: 'business.account-review',
  objectId: reviewId,
});
// { kind: 'created', actor: { kind: 'principal', id: 'ana' }, at: '…', invocationId: 'inv_a1' }

await runtime.host.provenance({
  objectDefinitionId: 'business.customer',
  objectId: customerId,
});
// { kind: 'adopted', actor: { kind: 'system', id: 'relate.host' }, at: '…', sourceDefinitionId: 'crm.customers' }
```

It returns `undefined` for an unknown object and `{ kind: 'unknown' }` for
objects stored before provenance was recorded. Provenance works with any store,
including stores without activity support.

Adoption is attributed to the system actor `relate.host` unless the host names
an actor:

```ts
await runtime.host.adopt(Customer, 'crm_456', {
  actor: { kind: 'principal', id: 'importer' },
});
```

---

## 4. Configuring Capture

```ts
const runtime = createRuntime({
  graph,
  connections,
  activity: {
    operations: 'enabled', // 'disabled' keeps the feed and provenance
    queueEntries: 1_000,
    queueBytes: 8 * 1024 * 1024,
    batchEntries: 100,
    maxObjects: 1_000, // lineage entries kept per operation
    maxOperationBytes: 256 * 1024,
    flushTimeoutMs: 5_000, // close() flush deadline
    onDiagnostic: (diagnostic) => metrics.record(diagnostic),
  },
});
```

The values above are the defaults. `onDiagnostic` receives sanitized drop and
truncation reports (operation kinds and counts, never IDs or values);
`runtime.host.activityCounters()` returns cumulative counters. An operation
whose lineage exceeds `maxObjects` is recorded with `details.truncated`.
`runtime.host.activity.status()` reports whether the store supports activity,
its durability and whether operation capture is enabled. A store without
activity support rejects feed and operation reads with `unsupported`, never an
empty history.

`close()` waits for in-flight operations, then flushes queued operation rows
until `flushTimeoutMs`. Rows still queued at the deadline are reported as
dropped with reason `shutdown`; a borrowed store stays open.

---

## 5. Storage and Retention

| Store    | Feed and operations                                                                    | Provenance |
| -------- | -------------------------------------------------------------------------------------- | ---------- |
| Memory   | Volatile; newest 10,000 feed entries and 10,000 operations per graph, with byte bounds | Volatile   |
| Postgres | Persistent; retained without pruning; cursors survive restart                          | Persistent |

`createMemoryStore({ activity: { feedEntries, feedBytes, operations, operationBytes, rowBytes, batchBytes } })`
adjusts the memory bounds; `createMemoryStore({ activity: false })` omits
activity support. When memory evicts feed history, a cursor behind the retained
beginning rejects with `cursor-expired` rather than skipping entries, and a new
memory store is a new stream whose old cursors also expire. A feed batch that
cannot fit the retained limits rolls back the write it belongs to.

With Postgres, a change and its object state, receipt and version row commit or
roll back together. Positions are allocated in commit order, so a checkpoint can
never skip an entry that commits later behind it.
