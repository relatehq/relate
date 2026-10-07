# Native account reviews

The first native action is executable through real packages. The
[application model and implementation](../../tests/support/native-action-model.ts)
use an API-owned Customer and a Relate-owned AccountReview. The
[shared acceptance suite](../../tests/support/native-action-contract.ts) runs
against memory and Postgres.

```ts
import { z } from 'zod';
import { defineAction, implementAction, referenceInput } from 'relate';
import { createRuntime } from '@relate/node';

// Customer, AccountReview and access come from the application's model.
const AddAccountReview = defineAction({
  id: 'business.add-account-review',
  input: z.object({ customer: referenceInput(Customer), note: z.string() }),
  output: z.object({ reviewId: referenceInput(AccountReview) }),
  creates: [AccountReview],
  policy: { execute: access.role('account-manager') },
});

// Register actions: { addAccountReview: AddAccountReview } in graph.
const addAccountReview = implementAction(
  graph,
  AddAccountReview,
  async ({ actor, input, objects }) => {
    const customer = await objects.Customer.get(input.customer, {
      select: ['id'],
    });
    if (customer.status !== 'ok') throw new Error('Customer unavailable');
    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: input.note,
    });
    return { reviewId: review.id };
  },
);

const relate = createRuntime({
  graph,
  connections,
  actionImplementations: [addAccountReview],
  // Supply store: createPostgresStore(...) after migrating it for durability.
});
const receipt = await relate.as(ana).actions.addAccountReview({
  input: { customer: northwind, note: 'Follow up' },
  idempotencyKey: 'review-2026-10',
});
// { invocationId, state: 'succeeded', output: { reviewId } }
const review = await relate
  .as(ana)
  .objects.AccountReview.get(receipt.output.reviewId);
```

Native objects use `membership: nativeMembership()`, scalar `native(...)`
properties, `objectId(...)`, and native references such as
`customer: reference(Customer, { id: 'review.customer' })`. Native membership
cannot be established through `host.adopt`. Creation is available only inside an
action whose `creates` includes that registered native object.

## Authorization and transaction contract

`creates` grants capability, not permission. Graph policies separately govern
reads and proposed create values:

```ts
AccountReview: {
  read: {
    gate: access.role('employee'),
    where: { customer: { portfolio: { eq: access.claims.portfolio } } },
    evidenceMaxAgeMs: 30_000,
  },
  create: {
    gate: access.role('account-manager'),
    where: {
      customer: { portfolio: { eq: access.claims.portfolio } },
      author: { eq: access.actor.id },
    },
    evidenceMaxAgeMs: 30_000,
  },
}
```

The runtime validates reference inputs and native writes against actual object
membership. A parsed string does not establish the record's type or existence.
Create rules apply even without the implementation's explicit customer read. The
runtime checks every create and revalidates before finalizing, including related
source evidence. Source evidence follows its declared freshness bound; there is
no cross-source snapshot or lock on upstream data.

Actions see their own native writes through `get`. Other invocations cannot see
uncommitted native objects. Success commits native records, the input/key
association and the successful receipt together. Failed writes, thrown errors,
invalid output or receipt-storage failure roll back all native effects. Catching
a rejected object operation cannot make the transaction commit. Source
observation refreshes remain independently retained.

This slice returns only `SucceededReceipt<Output>`. A rejection throws a
sanitized `ActionError`; it does not persist a failed receipt. Confirmed
rollback also rolls back the key reservation. An unconfirmed COMMIT
acknowledgement throws `ActionError('uncertain')`, without claiming rollback.
Memory's successful commit is process-local; use Postgres for persistence across
reconnect/restart.

An unavailable object read or a recognized temporary storage failure rejects
with `ActionError('unavailable')`. Native effects and the key reservation have
not committed, so the caller can retry with the same key. Unknown implementation
errors remain `internal`; neither code exposes exception details. Source-read
fallback and authorization withholding retain their normal read semantics. Do
not automatically retry `uncertain`: its effects may already be committed.

Native execution has a 60-second budget after the graph lock is acquired. Hosts
can lower it through `createRuntime({ ..., actionTimeoutMs: 5_000 })`; accepted
values are integer milliseconds from 1 through 60,000. It covers the key claim,
reference checks, handler, outstanding object operations and receipt
preparation. Expiry revokes the invocation's object operations and rejects the
transaction callback, rolling back native writes and its key with
`ActionError('unavailable')`. A handler that later resumes cannot perform
further native writes.

Postgres native connection acquisition and graph-lock waits each have a
30-second budget. Because the lock wait is shorter than the default execution
budget, an action that legitimately runs for 45 seconds can cause another action
that starts waiting immediately to reject with `unavailable` after 30 seconds.
The waiting action has not run its handler and can retry with the same key.
Allowing callers to wait through the full execution budget would require raising
both the adapter's lock and statement timeouts: the advisory-lock query is also
subject to the statement timeout. Hosts can instead lower `actionTimeoutMs`.

These budgets accumulate. A caller could spend nearly 30 seconds acquiring a
native connection, nearly 30 seconds acquiring the graph lock, then 60 seconds
executing before its execution deadline expires: roughly two minutes before
database cleanup. This is not a hard two-minute limit for the entire request.

This is an execution budget, not an end-to-end request timeout: installation,
pool/lock waiting, database rollback and COMMIT have their own storage bounds.
The execution timer stops before COMMIT; delayed or lost acknowledgements retain
their normal success/uncertain semantics. JavaScript handler code itself cannot
be forcibly stopped, and independently retained source refreshes may finish.

## References after a target is deleted

Deleting a referenced object does not delete its referring native objects or
clear their stored links. For example, a Task created while its Invoice existed
remains readable after billing confirms deletion, provided the Task's own
customer-based read policy still permits it:

```ts
await objects.Invoice.get(invoiceId, { refresh: true });
// { status: 'not-found' } after billing confirms deletion

await objects.Task.get(taskId, { select: ['assignee', 'invoice'] });
// Relevant result fields:
// {
//   status: 'ok',
//   data: { assignee: 'sam' },
//   meta: {
//     completeness: 'partial',
//     degraded: true,
//     fields: {
//       assignee: { status: 'available', ... },
//       invoice: { status: 'unavailable' }
//     }, ...
//   }
// }
```

The unresolved invoice reference is withheld from the result. The evidence
reports `unavailable`, without disclosing whether the target was deleted or
hidden by authorization. `requireComplete: true` rejects this selection with
`ReadError('incomplete')`. If the Task's own policy depends on evidence that can
no longer be established, the Task read returns `not-found`; that does not
delete the Task. A consumer's `not-found` result alone is not proof of deletion.

The
[deleted-reference acceptance case](../../tests/support/deleted-reference-contract.ts)
runs against memory and Postgres through public creation and read APIs. It also
checks stored Task values to prove neither the record nor its link was removed.

### Future edits and deletion policies

Native update/delete operations are not implemented. Their agreed reference
behavior is:

- Creating a reference or changing its target must validate the proposed target
  and applicable write permissions. Creation already performs these checks.
- An unrelated edit, such as changing `Task.assignee`, may leave an existing
  broken invoice reference in place. The edit still needs its own write
  permission; it must not require repairing every unchanged reference.
- Changing fields used by an integrity rule must validate the affected rule. For
  example, changing `Task.customer` affects customer consistency with its
  invoice even if the invoice ID itself is unchanged. Constraint dependencies
  and validation timing need to be defined when update/integrity APIs land.

Cascading deletes are a future, opt-in capability, outside v1. Before
introducing them, define how a model declares deletion behavior, authorization
of dependent deletions, transaction/receipt semantics, cycles, and how confirmed
source deletions trigger native effects. A failed or unauthorized read must
never trigger a cascade. No cascade API is currently exposed.

## Wait for completion, lookup and recovery

An ordinary action call waits for execution and commit. Its receipt contains the
business result in `output`; callers do not need to poll:

```ts
const request = {
  input: { customer: northwind, note: 'Follow up' },
  idempotencyKey: 'review-2026-10',
};
const caller = relate.as(ana);
const receipt = await caller.actions.addAccountReview(request);
console.log(receipt.output.reviewId);

// Read the saved outcome without executing the implementation.
const saved = await caller.receipts.get(AddAccountReview, receipt.invocationId);

// Also works when the first response, including invocationId, was lost.
const recovered = await caller.actions.addAccountReview(request);
// saved and recovered contain the original invocationId and output.
```

Graph/action/key identifies the invocation. It is bound to the originating
host-authenticated `actor.id` and validated input. Same-actor, same-input
retries recover the committed success; changed input rejects with `conflict`.
Another actor rejects with `denied`, even with identical input and equivalent
roles. Concurrent matching calls serialize and return the same receipt without
running the handler twice, subject to the existing lock/execution budgets.

Lookup and replay require the current action gate, current access to input and
output references, and current object/field access for successful runtime reads
performed by the original handler. The runtime retains those read dependencies
automatically, using stable property IDs. This conservatively protects scalar
output derived from restricted fields: losing finance access prevents recovery
of a saved amount even if the object itself remains readable. No author-facing
read declaration is required. Authorization evidence follows the model's age
bounds; recovery does not promise an upstream snapshot or refresh every field.
Application code remains responsible for data obtained outside runtime object
operations and for the suitability of its declared output.

Missing, wrong-action, wrong-graph, legacy and inaccessible receipts reject with
the same sanitized `ActionError('denied')`. A denial does not alter the saved
success; restoring access allows retrieval. Other temporary lookup failures
return `unavailable`; lookup never executes business logic. Use a newly
authenticated principal handle after roles or claims change.

Postgres migration 4 retains old receipts and keys, but leaves their unknown
actor/read provenance null. These receipts are not consumer-recoverable and
their keys cannot execute again. No automatic key expiry or receipt deletion is
implemented. Future receipt-detail retention must not implicitly release keys.
Cross-actor recovery, key expiry and schema evolution need separate contracts.

Background submission is deferred for exploration. No `mode: 'background'`
option or `pending` response is implemented. A plain future MCP handler can
await the same action and return its completed output in one tool response.

## Deliberate limits of this slice

- A committed graph/action/idempotency key cannot execute again. Authorized
  matching retries recover the original success; they do not revalidate business
  conditions by rerunning the handler. A new business attempt needs a new key.
- Durable pending acceptance, background workers, persisted failed/domain
  receipts, and external effects are not implemented.
- Action schemas currently support ordinary object schemas with scalar fields
  and required `referenceInput` fields. Unsupported refinements, transforms,
  defaults, nested schemas and domain-error declarations reject at compilation
  or definition time rather than silently losing their behavior.
- Action object operations currently expose `get` and permitted native `create`.
  Queries, native-reference traversal, update/delete and Task integrity rules
  remain outside this slice. The full customer-graph fixture still sketches
  them.

## Verification

```sh
pnpm typecheck
pnpm exec vitest run --project unit packages/node/test/native-action.test.ts packages/runtime/test/actions.test.ts packages/relate/test/actions.test.ts
pnpm exec dotenvx run -f .env -- vitest run --project integration tests/integration/native-action.test.ts
```

The integration suite requires `RELATE_TEST_DATABASE_URL` pointing at a
dedicated existing database; its setup resets only that database's `relate`
schema. Tests cover committed storage as well as authorized reads, so a hidden
write cannot pass a rollback assertion merely by being unreadable.
