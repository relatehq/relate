# Actions, Mutations & Receipts

Relate handles writes through **native actions**. An action has a typed input
and output, runs in a transaction over Relate-owned records, can declare
business failures, and leaves a receipt bound to the caller.

Actions currently write only native objects, which Relate owns. They do not
write to source systems.

---

## The Action Philosophy

Application writes often fail in subtle ways:

- A write succeeds in one place but fails halfway through a later step.
- A client retries a request after a timeout and creates a duplicate.
- A business rule rejection ("customer inactive") surfaces as a generic
  exception with no record of what happened.

Relate actions address this:

1. Every invocation is tied to the calling principal and an idempotency key.
2. The handler's native writes commit together or not at all.
3. A declared business failure rolls back the writes and records a typed
   **failed receipt**.
4. Retrying with the same key returns the recorded receipt instead of running
   the handler again.

---

## 1. Defining an Action Contract

Define the contract with `defineAction`. It holds no handler code, so it can be
shared with clients:

```ts
// actions/add-account-review.ts
import { z } from 'zod';
import { defineAction, referenceInput } from 'relate';
import { access } from '../access.js';
import { AccountReview, Customer } from '../model.js';

export const AddAccountReview = defineAction({
  id: 'business.add-account-review',
  description: 'Record a new assessment of a customer account.',
  input: z.object({
    customer: referenceInput(Customer, {
      description: 'Customer being reviewed.',
    }),
    note: z.string().min(1).max(4000).describe('Assessment and next steps.'),
  }),
  output: z.object({ reviewId: referenceInput(AccountReview) }),
  // Native objects this action may create.
  creates: [AccountReview],
  // Declared business failures, recorded as failed receipts.
  errors: {
    customerInactive: z.object({ status: z.string() }),
  },
  // Without an execute policy, every invocation is denied.
  policy: { execute: access.role('account-manager') },
});
```

- **`referenceInput(Customer)`**: accepts a `Customer` object ID. Parsing only
  checks for a non-blank string; the runtime checks that the record exists and
  that the caller can see it when the action runs.
- **`output`** and **`creates`** are required. Only objects listed in `creates`
  get a `create` method in the handler, and each must have `nativeMembership()`.
- **`errors`** is optional. Each key is a failure code with a schema for its
  details.
- **`policy.execute`** is a single-role gate. The actor must also hold the read
  role of every object type the input references; otherwise invocation fails
  with `denied`. Created objects are also checked against their `create` policy;
  see [Access Control](../authoring/access-control.md#5-create-rules-create).
- **`description` and field descriptions**: explain the action to people and
  agents through discovery. Use Zod `.describe()` for ordinary fields; for
  branded object IDs, the `referenceInput` option and `.describe()` are
  equivalent. Blank descriptions are rejected at compile time.

Register the action in the graph. The key becomes the method name callers use:

```ts
// graph.ts (excerpt)
export const graph = defineGraph({
  id: 'business.graph',
  objects: { Customer, Invoice, AccountReview },
  relationships: { CustomerInvoices },
  actions: { addAccountReview: AddAccountReview },
  access,
  policies: {/* … */},
});
```

---

## 2. Implementing the Action

Bind a handler to the graph and action with `implementAction`. Keep it in a
server-only module:

```ts
// actions/add-account-review.server.ts
import { implementAction } from 'relate';
import { graph } from '../graph.js';
import { AddAccountReview } from './add-account-review.js';

export const addAccountReview = implementAction(
  graph,
  AddAccountReview,
  async ({ actor, input, objects, fail }) => {
    const customer = await objects.Customer.get(input.customer, {
      select: ['status'],
    });

    // Hidden and missing customers look the same: `not-found`.
    if (customer.status !== 'ok') throw new Error('Customer unavailable');

    // Rolls back native writes and records a failed receipt.
    if (customer.data.status !== 'active')
      fail('customerInactive', { status: customer.data.status ?? 'unknown' });

    const review = await objects.AccountReview.create({
      customer: customer.id,
      author: actor.id,
      note: input.note,
    });

    return { reviewId: review.id };
  },
);
```

The handler receives:

- `actor`: the calling principal.
- `input`: the parsed input.
- `objects.<Name>.get(id, options)`: reads as the caller, with the same result
  shape as [`get`](./reading-data.md#4-reading-an-object-by-id-get).
- `objects.<Name>.create(values)`: for objects in `creates`. Returns `{ id }`.
- `fail(code, details)`: ends the invocation with a declared failure. It rolls
  back even if the handler catches it.

Any other thrown error rolls back the writes and rejects the call with
`ActionError('internal')`. No receipt is recorded.

Pass the implementation to the runtime. `createRuntime` throws if any registered
action has no implementation:

```ts
// runtime.ts (excerpt)
export const relate = createRuntime({
  graph,
  actionImplementations: [addAccountReview],
  connections: [/* … */],
});
```

The runtime's store must support native transactions. The default memory store
and `@relate/postgres` both do.

---

## 3. Invoking Actions

Call the action as a principal, with its input and an idempotency key:

```ts
import { ActionError } from '@relate/node';

const caller = relate.as({
  id: 'ana',
  roles: ['employee', 'account-manager'],
  claims: { portfolio: 'emea' },
});

try {
  const receipt = await caller.actions.addAccountReview({
    input: { customer: customerId, note: 'Quarterly review completed.' },
    idempotencyKey: 'review-2026-q3-northwind',
  });

  if (receipt.state === 'succeeded') {
    console.log('Created review', receipt.output.reviewId);
  } else {
    // Declared failure: receipt.error is { kind: 'domain', code, details }.
    console.warn(receipt.error.code, receipt.error.details.status);
  }
} catch (error) {
  // Rejections are thrown and leave no receipt.
  if (error instanceof ActionError) console.error(error.code);
  else throw error;
}
```

`customerId` is an object ID from `relate.host.adopt` or an earlier read. A call
ends in one of two ways:

- **Receipt** (returned): `{ invocationId, state: 'succeeded', output }` or
  `{ invocationId, state: 'failed', error: { kind: 'domain', code, details } }`.
- **Rejection** (thrown `ActionError`): `denied`, `not-found`, `invalid`,
  `conflict`, `unsupported`, `unavailable`, `internal`, or `uncertain`.
  Rejections carry no private details.

A receipt can be fetched again later by the same principal:

```ts
const again = await caller.receipts.get(AddAccountReview, receipt.invocationId);
```

### Idempotency and Replay

When a call reuses an idempotency key for the same action:

- If a different principal made the original call, it is rejected with `denied`.
- If the input differs from the original, it is rejected with `conflict`.
- Otherwise the recorded receipt is returned and the handler does not run again.

Before returning a recorded receipt, Relate checks the caller's current access
again, so a principal who has since lost access cannot read it.

A complete working version of this action is in
[`dev/fixtures/customer-graph`](../../../../dev/fixtures/customer-graph/source/actions/add-account-review.server.ts).
