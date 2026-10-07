# Declared action failures

**Agreed 2026-10-06.** Expected business failures belong to the shared action
contract. The fixture checks declaration, implementation and consumer types;
action execution, validation, rollback and receipt persistence remain
unimplemented. HTTP/MCP mappings follow this contract rather than defining it.

## Authoring

```ts
// Shared EscalateAccount contract
errors: {
  inactive: z.object({}),
  tooManyInvoices: z.object({ limit: z.number().int().positive() }),
}

// Inside its async implementation
if (customer.data.status !== 'active') fail('inactive', {});
if (taskIds.length >= 1_000) fail('tooManyInvoices', { limit: 1_000 });
```

`errors` is optional; omission declares no business failures. `fail` comes from
the action context, accepts only that action's declared code and corresponding
schema input, and returns `never`. It aborts the invocation rather than
returning a value the implementation must propagate through every helper. No
error-class hierarchy or additional execution phase is required.

The executor must validate and parse details exactly once. Receipt details use
schema output, including transforms/defaults, and must be JSON-serializable. An
unknown code, invalid details or non-serializable output is an implementation
fault, not a valid domain failure. Static types do not replace these runtime
checks or installation-time contract compatibility checks.

Only expected business outcomes belong here. The escalation's `inactive` and
`tooManyInvoices` checks are declared. Its `Review unavailable` throw remains an
invariant failure; it must not become a public domain code or expose its raw
message. Applications own presentation of stable codes and typed details.

## Receipts and consumers

```ts
{
  invocationId: 'inv_123',
  state: 'failed',
  error: {
    kind: 'domain',
    code: 'tooManyInvoices',
    details: { limit: 1_000 },
  },
}
```

`Receipt<Action>` discriminates `succeeded` with output, `failed` with an error,
`pending`, and `uncertain`. All states carry `invocationId`; see
[lookup and recovery](./receipts.md). Failed receipts further distinguish
`domain` errors from `runtime` errors. Narrowing a domain code narrows its
details:

```ts
if (receipt.state === 'failed' && receipt.error.kind === 'domain') {
  if (receipt.error.code === 'tooManyInvoices') {
    console.log(
      `Choose an account with at most ${receipt.error.details.limit} open invoices`,
    );
  }
}
```

Runtime errors need no per-action declarations. The fixture sketches codes for
`denied`, `not-found`, `invalid`, `conflict`, `unsupported`, `unavailable` and
`internal`, without raw exception messages, stacks or arbitrary details. Their
precise mapping and the boundary between pre-invocation request rejection and a
recorded execution failure remain open. Unexpected exceptions map to a sanitized
internal failure only when the runtime can confirm failure; an unknown effect
outcome must remain uncertain.

Domain details are public result data, not private diagnostics. They may contain
only information the caller is allowed to receive; schema validation alone does
not grant disclosure permission. Receipt access must also enforce authorization.

## Execution and replay requirements

- `fail()` aborts the native invocation and rolls back all of its business
  writes, including writes before a later invoice-page failure. Catching its
  internal control signal must not allow the invocation to commit successfully.
- After native rollback is confirmed, persist the validated failure and its
  idempotency association. Failed business writes cannot contain the only copy
  of that receipt: it must survive their rollback. Crash recovery between
  rollback and receipt finalization remains executor work.
- Once recorded, the same invocation key and input return the original
  authorized failure without rerunning business logic, even if the customer
  later becomes active. A new business attempt uses a new key. Different input
  under an existing key rejects; it never replaces the earlier outcome.
- A failed receipt is a terminal outcome, not a promise to retry. Lookup and
  replay require current receipt authorization. Retention/key expiry, receipt
  policy authoring and cross-actor replay still need explicit policies.
- Native rollback cannot undo external effects. An external write with a lost
  acknowledgement remains `uncertain`; a later `fail()` cannot relabel it as a
  confirmed failure. Already confirmed external effects also remain real and
  require an external-action contract, not an implied rollback guarantee.

See the [acceptance cases](./acceptance-cases.md#declared-domain-failures) for
required behavior and [type probes](./validation/action-errors.ts) for the
checks that run today with `pnpm typecheck`. No declaration-only probe proves
these execution guarantees.
