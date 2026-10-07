# Action execution acceptance cases

Required outcomes, not executable tests or implemented APIs. The current fixture
uses async object operations and native creation. Update/delete, external
writes, preview and constraints remain behavioral directions with unselected
APIs. See [read cases](./read-cases.md),
[authorization cases](./authorization-cases.md), and
[open questions](./open-questions.md).

## Native atomicity and read-your-writes

The [receipt caller scenarios](./validation/receipt-scenario.ts) specify
completed lookup, recovery after a lost response, and access changes before
retrieval. See the [agreed receipt contract](./receipts.md). These full-fixture
scenarios remain typechecked; native success recovery now has executable
memory/Postgres package tests. Background acceptance and pending execution are
deferred for exploration.

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

## Declared domain failures

The [agreed failure contract](./action-errors.md) supplies typed `fail()` and
failed Receipt errors. These cases require the future action executor; only
their authoring/consumer types are checked today.

1. An authorized escalation of an inactive customer returns
   `{ invocationId, state: 'failed', error: { kind: 'domain', code: 'inactive', details: {} } }`.
   It makes no invoice query and creates no review or task.
2. An active customer with 1,001 open invoices fails with `tooManyInvoices` and
   `{ limit: 1000 }`. The review and all tasks created before the limit was hit
   are rolled back. Exactly 1,000 open invoices can succeed.
3. Failure details are validated and transformed exactly once. A
   string-to-number detail transform receives a string from `fail()` and exposes
   a number in the receipt. Unknown codes, invalid details and non-JSON outputs
   are implementation faults, never fabricated domain failures.
4. If action code catches the abort signal and returns success, the runtime
   still rejects completion and rolls back native effects. No writes after
   `fail()` may become committed effects.
5. Retrying the same input/key after a lost failure response returns the
   original recorded failure without running the implementation again. Making
   the customer active does not change that receipt. A new key permits a new
   attempt; changed input under the old key rejects. Receipt access remains
   authorization-checked.
6. A persisted failure receipt survives rollback of business writes. A crash or
   storage failure before receipt finalization cannot be reported as a durably
   recorded domain failure. Recovery must resolve the invocation bookkeeping
   without publishing a success or duplicating committed effects.
7. `Review unavailable`, a source failure and a denied object operation are
   runtime failures, not declared business codes. Raw exception messages, stacks
   and hidden policy evidence never appear in public receipts. Domain details
   also must not disclose fields the caller may not receive.
8. A provider write whose acknowledgement is lost remains `uncertain`, even if
   later code calls `fail('inactive', {})`. Native rollback provides no evidence
   that an external effect failed or was undone.

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

### Reference identity and create permission without a pre-read

The [reference-write scenario](./validation/reference-write-scenario.ts)
specifies the following regressions for `AddAccountReview`. Its replacement
implementation deliberately omits `Customer.get()` and writes directly. It is
typechecked only; the native-action executor and storage inspection driver are
not implemented.

| Case                                                                                                   | Required outcome                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Ana creates a review for Northwind with herself as author                                              | Success and exactly one committed review. This positive control prevents a runtime that denies every write from passing. |
| External `customer` input contains an adopted Invoice ID                                               | String parsing succeeds, but execution fails with no committed review. Parsing is not proof of Customer membership.      |
| Valid Customer input, but action code supplies an Invoice ID to `create`                               | The write itself rejects. Checking reference inputs only at invocation is insufficient.                                  |
| Action code supplies a nonblank, unadopted Customer ID to `create`                                     | The write rejects without adopting or inventing a customer.                                                              |
| Action code supplies Southbank's real Customer ID for Ana                                              | The create policy rejects even though the reference identifies an existing Customer.                                     |
| A valid Northwind review is created before a second write supplies an Invoice ID or Southbank customer | The action fails and neither review is committed. An allocated ID does not prove persistence.                            |

The write-only cases carry the candidate ID through a scalar input and parse it
inside the implementation, so invocation-time reference validation cannot mask a
missing write check. Failures are runtime-owned, with no hidden record values or
policy evidence in the error. Exact public error-code mapping remains open.

Run these scenarios against both memory and Postgres when native execution is
available. Assert committed storage independently of caller read authorization:
an empty authorized query alone cannot prove that a forbidden review was never
persisted. Source observation retention remains outside native-write rollback.

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
