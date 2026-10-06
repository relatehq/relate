# Action execution acceptance cases

Required outcomes, not executable tests or implemented APIs. The current fixture
uses async object operations and native creation. Update/delete, external
writes, preview and constraints remain behavioral directions with unselected
APIs. See [read cases](./read-cases.md),
[authorization cases](./authorization-cases.md), and
[open questions](./open-questions.md).

## Native atomicity and read-your-writes

An authorized escalation reads the customer, creates a review, reads that
review, queries open invoices and creates tasks. Later native reads in the
invocation see its writes. Another invocation must not observe uncommitted
business effects. Success commits all native writes, the receipt and idempotency
bookkeeping atomically. A failure during a later page, creation, output
validation or required policy check rolls back all native effects. No success
receipt survives rollback. A retry after a lost successful response returns the
original authorized receipt.

Runtime owns the transaction; implementations do not independently commit. ID
allocation can leave gaps on rollback and does not imply a durable object
exists. Source reads are outside native atomicity; observation retention is
distinct from business writes. Exact isolation, transaction length and retry
behavior are open.

## Sequential operations and final-state validation

The old one-mutation-per-record rule belonged to a sealed edit plan and is no
longer a general action rule. Future update/delete APIs must support ordinary
sequential native operations and read-your-writes. Define enforcement of
immediate versus final-state constraints explicitly; repeated updates are not
rejected merely for touching the same record twice. This fixture declares
creation only.

Invalid references, wrong object types, denied values or inconsistent links must
not leave partial business writes. Checks must consider newly created records in
the transaction without treating readable values as automatically writable.

## Conditional updates and concurrency

A future native update expecting revision 7 must conflict if revision 8 is
current, leaving none of that invocation's native effects. Check at the write
within the transaction. For a hypothetical one-active-review rule, concurrent
invocations observing no active review must not both commit one. A preflight
query is not a uniqueness constraint. Constraint and error APIs remain open.

A native transaction does not ensure an externally owned invoice remains open.
Reject a requested guarded provider write that the connector cannot enforce; a
recent reread is not an atomic provider condition.

## Optional preview and approval

Do not promise preview for arbitrary action code. If a future supported preview
produces a saved proposal, it must not perform business writes or provider
mutations. Bind the shown effects to validated inputs/references, release,
relevant state and expiry. Recheck authorization and material drift before
execution; never rerun and silently replace approved effects. Hidden values must
not leak in previews. Eligibility and exact authoring APIs are open; this is not
a phase required by the current examples.

## One external destination, acknowledgement lost

For a future authorized CRM update:

1. Persist validated invocation intent, action/release identity and provider
   conditions before submitting the mutation. A failed intent save prevents I/O.
2. CRM accepts the mutation but its acknowledgement is lost.
3. Keep the intent and report `uncertain`, not a confirmed failure.
4. The same idempotency key must not blindly submit again. Require provider
   idempotency or conclusive reconciliation; desired values alone need not prove
   this invocation caused them.
5. Cover a crash after acceptance but before receipt update. Pending intent does
   not establish that submission never happened.

There is one external business-write destination. Persisting execution metadata
is not another native business effect. This does not promise compensation or
rollback across CRM and native review/task writes. See
[write execution](../../../../relate-internal/docs/internal/writes.md).

## Deferred directions

Attributed relationships, updates/deletes, host transaction participation,
external orchestration, optional preview, aggregate queries and
provider-generated IDs require concrete examples before more authoring API is
added. Oversized atomic invocations reject against explicit bounds, never
silently chunk. Do not reintroduce a mandatory plan builder to accommodate an
optional feature.
