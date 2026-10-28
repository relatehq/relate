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

First define the
[native AccountReview object](../authoring/graph.md#native-objects) and its
[create policy](../authoring/access-control.md#5-create-rules-create).

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
- **`output`** is required. **`creates`** and **`adopts`** are optional and
  default to empty lists. Only objects listed in `creates` get a `create` method
  in the handler, and each must have `nativeMembership()`. Only source objects
  listed in `adopts` get an `adopt` method; see
  [Creating platform records and adopting them](#creating-platform-records-and-adopting-them).
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

- `idempotencyId`: your caller's idempotency key scoped to this graph instance,
  actor and action. It stays the same across retries, including after a thrown
  error. Forward it to external APIs instead of the raw key.
- `actor`: the calling principal.
- `input`: the parsed input.
- `objects.<Name>.get(id, options)`: reads as the caller, with the same result
  shape as [`get`](./reading-data.md#4-reading-an-object-by-id-get).
- `objects.<Name>.query(options)`: enumerates or filters graph members with the
  same [query API](./reading-data.md#querying-objects-query) as consumers.
  Native queries see records created earlier in this invocation. A failed page
  rolls back native writes even if the handler catches the error.
- `objects.<Name>.create(values)`: for objects in `creates`. Returns `{ id }`.
- `objects.<Name>.adopt(sourceRecordId)`: for source objects in `adopts`.
  Registers a platform record as a graph member when the action commits. Returns
  `{ id }`.
- `fail(code, details)`: ends the invocation with a declared failure. It rolls
  back even if the handler catches it.

Any other thrown error rolls back native writes and rejects the call with
`ActionError('internal')`. No receipt is recorded.

Pass the implementation to the runtime. `createRuntime` throws if any registered
action has no implementation:

```ts
// runtime.ts (excerpt)
export const relate = createRuntime({
  graph,
  actionImplementations: [addAccountReview],
  bindings: [/* … */],
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
    idempotencyKey: 'review-2026-q3-mothlight',
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
const again = await caller.receipts.get(
  'addAccountReview',
  receipt.invocationId,
);
```

### Idempotency and Replay

When a call reuses an idempotency key for the same action:

- If a different principal made the original call, it is rejected with `denied`.
- If the input differs from the original, it is rejected with `conflict`.
- Otherwise the recorded receipt is returned and the handler does not run again.

Before returning a recorded receipt, Relate checks the caller's current access
again, so a principal who has since lost access cannot read it.

The
[connected sources example](../../../../examples/02-connected-sources/README.md)
is a runnable review-creation example with receipt replay. Its
[handler](../../../../examples/02-connected-sources/src/app.ts) demonstrates
successful creation; the declared `customerInactive` failure above extends that
example to show an additional business outcome.

If the first response is lost, retry with the original input and idempotency key
to recover the receipt even without its invocation ID. A new business attempt
needs a new key. Receipt recovery also checks access to the original handler's
read dependencies; losing access to a field used to produce the result can deny
recovery. Use a newly authenticated caller handle after roles or claims change.

See the [native action contract](../../../../packages/node/NATIVE_ACTIONS.md)
for transaction boundaries, concurrent retries, dependency checks, and recovery
limits. The native transaction does not cover external side effects; see
[External writes and idempotency IDs](#external-writes-and-idempotency-ids).
Background execution is not supported.

### External writes and idempotency IDs

A handler can forward `idempotencyId` to a provider's idempotency API or an
integration-owned operation journal:

```ts
// Inside an implementAction handler. provider is your integration's API client.
async ({ idempotencyId, input }) => {
  const result = await provider.createComment({
    transactionId: input.transactionId,
    comment: input.comment,
    idempotencyKey: idempotencyId,
  });
  return { commentId: result.id };
};
```

Why not forward the caller's `idempotencyKey` directly? Relate reserves a key
per graph instance and action. Different graph instances or actions can reuse
`idempotencyKey: '1'`, while a provider may see only the string and merge their
requests. `idempotencyId` includes the graph instance, action and actor:

```ts
// Ana calls addAccountReview({ input, idempotencyKey: '1' }) in two graph instances.
// graphId 'workspace-a': idempotencyId === 'relate-op-v1-3f9a…'
// graphId 'workspace-b': idempotencyId === 'relate-op-v1-b27c…'
```

The actor in the derived ID does not give each actor a separate receipt-key
namespace. Within one graph and action, another actor reusing a key with a saved
receipt receives `denied`, as described under
[Idempotency and Replay](#idempotency-and-replay).

`idempotencyId` is an opaque, deterministic identifier scoped to the runtime's
`graphId`, actor ID, action definition ID and caller idempotency key. It
survives handler rollback and runtime restart when those values stay the same.
Input and definition revision are deliberately excluded: an external journal
must reject changed input under the same identity, including after deployment.
Separate installations sharing a provider account must use distinct stable
`graphId`s. It is not the receipt's `invocationId`, a secret, or an
authorization credential.

Relate's transaction covers native writes and receipts. It cannot roll back an
external API call. Passing `idempotencyId` only helps if the provider or
integration actually enforces deduplication. Scope journal entries to the
provider account, reserve before dispatch, and retain confirmed results
independently of the native transaction. Track graph refresh separately so a
failed readback does not discard a confirmed mutation. Receipt replay skips the
handler, so pending refreshes need a separate recovery path.

If a provider response is lost, use provider idempotency or operation lookup to
reconcile it. Without either capability, keep the outcome uncertain and block
blind retries. A local journal cannot close the crash window between provider
commit and recording its response. The SDK does not provide that journal or an
external-write transaction coordinator.

### Creating platform records and adopting them

A handler that creates something on a platform, such as a TikTok ad group, can
turn the new record into a graph object in the same invocation. Declare the
source objects the action may adopt:

```ts
// actions/launch-ad-group.ts
export const LaunchAdGroup = defineAction({
  id: 'launch-ad-group',
  input: z.object({ name: z.string(), budget: z.number() }),
  output: z.object({ adGroupId: referenceInput(TikTokAdGroup) }),
  adopts: [TikTokAdGroup],
  errors: { notVisible: z.object({ externalId: z.string() }) },
  policy: { execute: access.role('media-buyer') },
});
```

The handler creates the record (or recovers an earlier attempt's), waits until
the platform can serve it, then adopts it:

```ts
// actions/launch-ad-group.server.ts
export const launchAdGroup = implementAction(
  graph,
  LaunchAdGroup,
  async ({ input, objects, idempotencyId, fail }) => {
    // Integration code: your journal creates once per idempotencyId and
    // recovers the platform ID on a retry.
    const { adgroup_id } = await journal.once(idempotencyId, () =>
      tiktok.createAdGroup({ name: input.name, budget: input.budget }),
    );

    // Integration code: platforms often return an ID before their read API
    // can serve the record. Poll with your own client and declare the outcome.
    if (!(await tiktok.waitForAdGroup(adgroup_id, { timeoutMs: 5_000 })))
      return fail('notVisible', { externalId: adgroup_id });

    const { id } = await objects.TikTokAdGroup.adopt(adgroup_id);
    const group = await objects.TikTokAdGroup.get(id); // sees the pending object

    return { adGroupId: id };
  },
);
```

What `adopt` does:

- It fetches the record once through the object's source binding and checks that
  the caller can read it. Adoption never grants read access.
- It returns the object's Relate ID. A record that is already a member keeps its
  ID; adopting the same record again in one invocation returns the same ID.
- The new object is pending: `get` and `query` in the same handler see it, and
  native objects you create may reference it. Other callers see it only after
  the action commits. Pending field evidence reports `retention: 'unconfirmed'`.
- Membership commits or rolls back with the action. A thrown error, timeout,
  invalid output or `fail(code)` leaves no new member behind.

| `adopt` outcome                                   | Result                                   |
| ------------------------------------------------- | ---------------------------------------- |
| Record fetched and readable by the caller         | `{ id }`                                 |
| Caller cannot read it, or it is deleted           | Action rejects with `not-found`          |
| Platform denies the configured account            | Action rejects with `denied`             |
| Connector error (including a not-yet-visible 404) | Action rejects with `unavailable`; retry |
| Invalid ID, or the record fails mapping           | Action rejects with `invalid`            |
| The record changed or was adopted elsewhere first | Action rejects with `unavailable`; retry |

A failed `adopt` rejects the action even if the handler catches it, and no
receipt is saved, so the caller can retry with the same idempotency key. The
retry reruns the handler; your journal must return the record the first attempt
created instead of creating another one. If a newer, identical copy of the
record was saved while the action ran, the action still succeeds.

Before committing, Relate rechecks every adopted object's read policy, including
objects not returned by the handler. If evidence used by an earlier check
expires while a later check runs, the action rejects with `unavailable`. Retry
with the same idempotency key so the handler can validate fresh evidence.

**Keep waits short.** The whole handler, including visibility polling, runs
while the graph's action lock is held: a handler that polls for five seconds
blocks every other action in that graph for five seconds. The action deadline
(`actionTimeoutMs`, at most 60 s) bounds the whole invocation.

Relate guarantees the local side only. If the platform created the record and
the action then fails, the record stays on the platform; Relate never deletes
it. Recovery after a lost platform response is the journal's job, using
documented platform reads.
