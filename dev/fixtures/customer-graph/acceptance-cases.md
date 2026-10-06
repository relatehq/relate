# Action planning acceptance cases

These are required behavioral scenarios, not executable tests or implemented
APIs. The TypeScript fixture currently declares native creation only. Exact
update, condition, relationship-edit, preview and connector signatures remain
open. The selected API lives under `source/`, with checks and scaffolding under
`validation/`. [Open questions](./open-questions.md) records unresolved design
choices against that API. The decision and research are in
[internal action planning](../../../../relate-internal/docs/internal/action-planning.md).

## Builder and native creation

Given the existing customer and invoice records, planning `escalateAccount`
allocates one review ID and one task ID per visible open invoice. Each task
references that review ID. Planning and sealing create no business objects. The
sealed plan retains those IDs and complete values. Successful execution commits
all native creations and the receipt together. Retrying the same authorized
invocation returns its original receipt and creates nothing extra.

Mutating input objects after sealing must not change the saved proposal. Using
the builder after sealing must reject. Runtime validation must reject forged or
foreign plans even when callers bypass TypeScript. Mechanisms remain open.

## Duplicate mutation targets

Given an existing review, a plan attempting two updates to it rejects even if
one changes the note and the other changes the author. Update-then-delete and
create-then-update/delete also reject. No partial business writes occur. Helpers
must assemble complete values before recording the one mutation.

Distinct edges from one customer to two reviews are not duplicates merely
because they share an endpoint. Two edits to the same edge reject. A
reference-property update and a relationship edit backed by that same record
must not bypass the duplicate-target rule. Exact normalized identities await the
relationship-edit API.

## Conditional native update

Given a review read at native revision 7, another invocation commits revision 8
before this plan executes. An update requiring revision 7 reports conflict,
preserves revision 8, and makes none of its proposed business changes. Check the
condition within the native write transaction, not only during planning. The
conflict receipt/error representation remains open.

## Concurrent creation constraint

Given a proposed rule allowing one active review per customer, two invocations
with different idempotency keys both observe no active review. At most one may
create the active review. The other receives a constraint/conflict outcome;
neither silently overwrites the winner. This scenario introduces a test rule,
not a global restriction on AccountReview. A preflight existence read alone does
not satisfy it. Constraint authoring and transactional enforcement remain to be
designed.

## Relationship with properties

Given a proposed native assignment relationship between a review and an
employee, create an assignment carrying role and effective date. Validate its
endpoints, allowed properties, policy and cardinality before committing it.
Invalid endpoints or denied values leave no edge or companion business edits.
The model and editing syntax are intentionally unspecified; an edge object or
first-class attributed relationship remains an API choice. Source-owned links
cannot be mutated as if Relate owned them.

## Read completeness and drift

Given an action requiring a complete set of open invoices, a truncated or
unavailable read must not become a successful plan claiming all invoices were
handled. Actor-visible scope must be explicit; do not reveal hidden records or
elevate access to make a read complete. Required field/freshness/coverage APIs
remain open.

If an invoice changes after planning, the action must follow its declared
condition semantics. A native transaction cannot guarantee an external invoice
remains open. Reject a requested guarantee that the connector cannot enforce; do
not equate a recent reread with an atomic provider condition.

## Saved preview and approval

Given a preview requiring approval, retain its edits, IDs, output and relevant
bindings. Preview performs no business writes or provider mutations. Execute the
approved proposal only after current access, expiry and relevant state are
checked. Material drift requires a new preview/approval; do not rerun the
implementation and silently replace approved effects. Unauthorized before-values
must not appear in a public preview. Exact storage/binding APIs remain open.

## One external destination, acknowledgement lost

Given an authorized customer update to the CRM:

1. Persist the invocation's intent, target, validated input, action/release
   identity and required provider condition before submitting the provider
   mutation. If saving the intent fails, do not call the provider.
2. Let the CRM accept the write, then lose its acknowledgement.
3. Retain the saved intent and report an `uncertain` receipt. Do not label the
   action failed merely because the response was lost.
4. Retry with the same idempotency key. Preserve the original invocation and do
   not blindly submit a second mutation. Recovery uses provider idempotency or
   conclusive reconciliation evidence; without it, uncertainty remains.
5. Also cover a crash after provider acceptance but before receipt update:
   durable pending intent does not prove the request was never sent.

This scenario has **one external business-write destination**. Saving Relate's
intent/receipt is execution bookkeeping, not an added native business effect. It
does not create a native review, send an email, define compensation, or promise
distributed rollback. See the boundary in
[write execution](../../../../relate-internal/docs/internal/writes.md).

## Deferred directions

Circular new-object handles, staged queries over pending edits and automatic
oversized-action routing are outside these initial fixtures. Oversized atomic
actions should reject against an explicit limit rather than silently split; the
limit remains open. No executable fixture here proves these behaviors yet.
