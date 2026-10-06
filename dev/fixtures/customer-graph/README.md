# Customer graph acceptance fixture

The application we want developers to write, before the packages can run it.
This fixture is type-checked by `pnpm typecheck` and never executed. CRM owns
customers, billing owns invoices, and Relate owns account reviews and tasks.

## Start with the authoring source

The selected Actions API is **B: bind each implementation to its action**, using
one application-scoped access-configured binder. There is one active example;
the earlier [binding spike](../handler-binding-spike/README.md) is historical
comparison evidence.

```text
source/
  access.ts                         shared roles, field groups and claim types
  model.ts                          sources, objects and relationships
  graph.ts                          registration and object policies
  app.server.ts                     runtime composition and implementation registration
  actions/
    implement-action.server.ts      configures the server binder once with access
    add-account-review.ts           shared action contract and execution policy
    add-account-review.server.ts    action-bound implementation
    escalate-account.ts             shared action contract and execution policy
    escalate-account.server.ts      action-bound implementation
validation/
  target.ts                         declarations for APIs not implemented yet
  rejections.ts                     positive and negative TypeScript probes
  scenario.ts                       intended embedded outcomes, not executed yet
  setup.ts                          simulated connections and sample principals
  records.ts                        sample provider data
```

Read an action's `.ts` file and its adjacent `.server.ts` implementation first.
Declarative execution policy lives with the action contract. Graph assembly
registers actions without overriding their policies. Missing action policies
mean denied discovery and execution. Object policies still live in `graph.ts`.

`implement-action.server.ts` exports
`implementAction = createActionImplementer(access)`. This local binder supplies
role/claim types, not permissions or a global current user. Each implementation
binds directly to its action, without importing the graph. `app.server.ts`
passes the implementations directly to
`createRuntime({ graph, actionImplementations: [addAccountReview, escalateAccount], connections })`.
The runtime signature checks completeness, uniqueness and compatibility; there
is no separate implementation-registration wrapper.

The builder records complete creations with `changes.create(Object, values)` and
seals them with `changes.build(output)`. Native IDs are assigned during
planning; no business writes occur. Planning is synchronous. Literal action IDs
allow registration checks for missing, duplicate and foreign implementations.
The
[internal decision](../../../../relate-internal/docs/internal/action-planning.md)
records the builder/plan rationale and primary research.

## Validation is separate from authoring

`source/` contains the application code; `validation/` contains this fixture's
scaffolding and checks. The temporary exception is that authoring imports
`validation/target.ts`, which re-exports existing helpers and declares the APIs
that packages still owe. It is not a proposed public import path. Replace those
imports with real package exports when implemented; do not add runtime code just
to make this fixture execute.

`source/app.server.ts` accepts connections. The validation setup supplies sample
connectors and principals; production hosts supply actual connections and
trusted authenticated principals. Shared modules do not import `.server.ts`
files. The suffix communicates intent; bundle enforcement is still open.

`validation/scenario.ts`, `validation/rejections.ts` and
[acceptance-cases.md](./acceptance-cases.md) describe intended behavior. Change
those expectations only when the contract changes. Typechecking is not proof of
runtime authorization, atomicity, approval binding or recovery.

## Remaining work

[open-questions.md](./open-questions.md) separates settled choices, unresolved
contracts and deferred directions. It includes action-specific authorization,
policy checks on proposed values, read completeness, concurrency, plan
serialization, registration compatibility, identity and external uncertainty.

The TypeScript source covers native creation and declared relationship reads.
The acceptance cases specify additional behavior without inventing unimplemented
update, conditional-write or connector APIs. Membership uses `host.adopt` for
fixture setup; production discovery is through synchronization. Billing's CRM
key shortcut remains an explicit interim assumption in `source/model.ts`.
