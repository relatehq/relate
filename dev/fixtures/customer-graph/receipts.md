# Action receipts and recovery

**Agreed 2026-10-07:** ordinary action calls wait for completion. The native
success path now implements lookup and replay through real packages; background
submission is deferred for exploration.

```ts
const caller = relate.as(ana);
const request = {
  input: { customer: northwind, note: 'Follow up' },
  idempotencyKey: 'review-2026-10',
};
const receipt = await caller.actions.addAccountReview(request);
console.log(receipt.output.reviewId);

const saved = await caller.receipts.get(AddAccountReview, receipt.invocationId);
const recovered = await caller.actions.addAccountReview(request);
// Same invocation and original output, without another write.
```

Graph/action/key identifies the invocation. The originating authenticated actor
and validated input bind execution. Another actor cannot replay or retrieve it;
changed input rejects. Lookup/replay check current action, reference and
recorded object/field access. Losing access withholds the saved result without
rewriting success as failure. Restoring access permits retrieval.

Applications should persist the request before submission. If a response is lost
before receiving its invocation ID, retry the same request under the same actor.
A known ID can instead be retrieved without invoking the action. Concurrent
identical calls share one committed result, subject to waiting budgets. Keys do
not automatically expire, and deleting receipt details must not implicitly make
a key reusable. Legacy receipts without actor/read provenance remain protected
and non-replayable.

The package suites in `tests/support/native-action-contract.ts` and
`receipt-recovery-contract.ts` execute these guarantees on memory and Postgres.
See
[the native action contract](../../../packages/node/NATIVE_ACTIONS.md#wait-for-completion-lookup-and-recovery)
for errors, evidence bounds and migration behavior.

The broader [type probes](./validation/receipts.ts) and
[caller scenarios](./validation/receipt-scenario.ts) remain typechecked only:
they also describe unimplemented domain errors and native traversal. The full
receipt union retains future pending/uncertain states, but ordinary action calls
exclude `pending`; today's executable return is success-only and rejections
throw sanitized errors. Background execution, persisted failures and
external-effect recovery are not implemented.

The internal agreement and proposed background exploration are in
`relate-internal/docs/internal/action-receipts.md`. No background option has
been added to the package API.
