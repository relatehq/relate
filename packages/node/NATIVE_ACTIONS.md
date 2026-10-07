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

## Deliberate limits of this slice

- A committed graph/action/idempotency key cannot execute again. Duplicate keys
  reject with `conflict`, including concurrent duplicates and changed inputs.
  Recovering the original outcome through replay or receipt lookup is the next
  slice. A duplicate never blindly resubmits a write.
- Durable pending acceptance, background workers, consumer receipt lookup,
  persisted failed/domain receipts, and external effects are not implemented.
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
