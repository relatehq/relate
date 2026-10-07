# Action receipts and recovery

**Agreed 2026-10-07; declaration-only acceptance.** Every receipt state carries
an opaque `invocationId`. Callers save it and retrieve the latest receipt with
`relate.as(principal).receipts.get(Action, invocationId)`. The action argument
preserves output and domain-error types. Runtime verifies graph/action identity
and current authorization; lookup never executes the action.

The [caller scenarios](./validation/receipt-scenario.ts) show:

1. Persist the input and idempotency key before submitting. Receive `pending`,
   save its invocation ID, retrieve pending again, then retrieve success after
   completion. `pending` promises durable acceptance, not an in-process promise.
2. Lose the initial response after native commit, including its invocation ID.
   Reload the saved request and call the action with the same key/input. Recover
   the existing invocation and original outcome without a second review. Keys
   are scoped to graph/action and bound to validated input; different input
   rejects without replacing the outcome.
3. Remove Ana's required role or Northwind portfolio access. Both lookup and
   same-key replay reject without revealing saved output or error details.
   Knowing an ID/key/input is not authorization. A lookup denial cannot change a
   succeeded invocation to failed; restoring access reveals the same success.

Lookup/replay retain invocation identity as its state advances. Losing a caller
response does not make a recorded success `uncertain`. Uncertainty means Relate
itself cannot establish the effect outcome, for example after losing a provider
write acknowledgement. Lookup and same-key replay must not blindly resubmit it;
conclusive reconciliation is required. Missing, mismatched and inaccessible IDs
must not reveal hidden invocation existence.

[Type probes](./validation/receipts.ts) check identity on all states and typed
lookup. `pnpm typecheck` checks these declarations and scenarios; they are not
executed and do not prove durability, scheduling, authorization or recovery. The
scenario's persistent journal and pause/drop-response controls are future
test-runner dependencies, not public Relate APIs or a fake executor.

Receipt policy authoring/evidence freshness, rejection shapes, cross-actor
replay, retention/key expiry and schema evolution remain open. The full internal
agreement and caller walkthrough is `docs/internal/action-receipts.md` in
`relate-internal`.
