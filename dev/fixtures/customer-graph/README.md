# Customer graph acceptance fixture

The application we want developers to write, before the packages can run it.
This fixture is type-checked by `pnpm typecheck` and never executed. CRM owns
customers, billing owns invoices, and Relate owns account reviews and tasks.

## Current authoring direction

Actions declare input/output schemas, creation capabilities and colocated
execution policies. Adjacent `.server.ts` implementations are asynchronous:
query objects when needed, branch, perform supported writes, and return output.
There is no special action target, upfront read declaration or change builder.

```text
source/
  access.ts                         shared role/claim vocabulary
  model.ts                          objects, shared object registry, relationships
  graph.ts                          assembly and object policies
  app.ts                            server runtime composition
  actions/
    implement-action.server.ts      binder configured with access and objects
    add-account-review.ts           input reference and action contract
    add-account-review.server.ts    authorized lookup and native creation
    escalate-account.ts             escalation contract
    escalate-account.server.ts      conditional query, native read/write/read
    review-invoice.ts               invoice reference input
    review-invoice.server.ts        lookup using an ID from an earlier result
validation/
  target.ts                         temporary declaration-only API shim
  rejections.ts                     positive and negative type probes
  policies.ts                       nested policy inference and rejection cases
  check-policies.mjs                independent unsuppressed rejection check
  scenario.ts                       intended outcomes, never executed
  setup.ts                          simulated connections and principals
  records.ts                        provider data
```

`referenceInput(Customer)` accepts an ID in the request and supplies a typed
`{ id }` reference after parsing. It does not load the object or authorize
access. For example, invocation input is
`{ customer: customerId, note: 'Follow up' }`.

`createActionImplementer({ access, objects })` binds implementations to
contracts. The registry is exported once from `model.ts` and shared by graph
assembly and the binder so `objects.Customer` is inferred without a graph import
cycle. It is a type/installation context, not a read allowlist or a permission
grant. The runtime must validate object identities and vocabulary compatibility
at installation.

`access.forObjects(objects)` binds the same registry once in `graph.ts` and
returns `policy`. Object rules use nested predicates:

```ts
const { policy } = access.forObjects(objects);

policy(Invoice, {
  read: {
    gate: access.role('employee'),
    where: { customer: { organization: { eq: access.claims.organization } } },
    evidenceMaxAgeMs: 30_000,
  },
  groups: { financial: access.role('finance') },
});
```

This is explicit related-attribute comparison, not delegation to Customer's
entire policy. Binding supplies type context, not permissions. Customer uses a
root organization condition; Invoice, AccountReview and Task use their direct
customer references. Validation also checks multi-hop paths. Task reference
consistency remains a separate write/integrity requirement. Predicates require
an evidence age bound; role-only policies do not. The declaration shim checks
field names and claim types, including extracted conditions.

Run `node dev/fixtures/customer-graph/validation/check-policies.mjs` to verify
negative policy cases independently, with suppression comments removed in
memory. The
[internal comparison](../../../../relate-internal/docs/internal/relationship-policy-research.md)
retains the path-helper alternative and the removed spike's findings.

`createRuntime({ graph, actionImplementations, connections })` checks action
registration. `creates` limits native creation capability; runtime policies
still must authorize the values and relationships. Source-owned objects have no
native `create` operation. Source-backed reads are not part of the native
transaction.

The intended native execution contract is one runtime-owned transaction:
interleaved native reads see earlier writes, success commits effects and
receipt, and failure rolls back native effects. This is a proposed guarantee,
not proven by declaration types. There is no author-facing commit call or
mandatory preview.

## Examples and limits

- Add a review after checking the referenced customer is readable.
- Escalate only active customers. Query open invoices only on that branch, page
  through results, and create tasks. Read the new review inside the invocation.
  A later query or write failure must roll back earlier native writes.
- Review an invoice by first reading its customer reference, then reading that
  customer's name. The second ID is not known upfront.

Queries use selected fields, equality filters and ordinary pagination. This is a
minimal query sketch, not a finished query language. Partial object reads remain
explicit in types; the examples reject missing required evidence. Query filters
must not silently exclude rows because filter evidence is unavailable. Native
read-your-writes must still respect field/object authorization.

[Read cases](./read-cases.md), [execution cases](./acceptance-cases.md), and
[authorization cases](./authorization-cases.md) specify required outcomes.
[Open questions](./open-questions.md) identifies guarantees and syntax still to
resolve. Graph policies now express organization isolation through each child's
customer reference; runtime enforcement is still unimplemented.

The
[current internal decision](../../../../relate-internal/docs/internal/action-authoring.md)
records the minimal-API principle and superseded alternatives. The separate
action-target spike has been removed. Historical research remains in the
internal design docs, not as multiple active APIs in this fixture.

`validation/target.ts` is a temporary import path, not public API packaging.
Authoring source imports no test data. Exact transport errors, transaction
isolation/retries, query coverage and preview eligibility remain open. Do not
implement runtime behavior merely to make these declarations execute.
