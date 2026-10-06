# Customer graph acceptance fixture

The full application we want developers to write. The `source/` fixture is
type-checked by `pnpm typecheck` and never executed. Its implemented read subset
lives in [`invoice-read/`](./invoice-read/README.md). CRM owns customers,
billing owns invoices, and Relate owns account reviews and tasks. All users work
within one company's instance. Access follows assigned customer portfolios: Ana
and Fin handle North; Sara handles South. Finance access is a separate role, not
permission to see every portfolio.

The first read slice is now executable through `@relate/node`: named object
registries, `connect`, `host.adopt` and principal-bound typed `get`. See
[hello world](../../../examples/hello-world/README.md) and
[`typed-read.test.ts`](../../../packages/node/test/typed-read.test.ts). The full
fixture still uses declarations for native objects, native references, queries
and actions. Source-backed references, nested read policies and bidirectional
Customer–Invoice traversal are executable in the Invoice read subset.

## Current authoring direction

Actions declare input/output schemas, creation capabilities and colocated
execution policies. Adjacent `.server.ts` implementations are asynchronous:
query objects when needed, branch, perform supported writes, and return output.
There is no special action target, upfront read declaration or change builder.

```text
source/
  access.ts                         shared role/claim vocabulary
  model.ts                          objects, shared object/relationship registries
  graph.ts                          assembly and object policies
  app.ts                            server runtime composition
  actions/
    implement-action.server.ts      binder with access, objects and relationships
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
  write-policies.ts                 create and integrity type cases
  check-write-policies.mjs          independent write-rule rejection check
  check-policies.mjs                independent unsuppressed rejection check
  scenario.ts                       intended outcomes, never executed
  setup.ts                          simulated connections and principals
  records.ts                        provider data
```

`referenceInput(Customer)` accepts an ID in the request and supplies a typed
`{ id }` reference after parsing. It does not load the object or authorize
access. For example, invocation input is
`{ customer: customerId, note: 'Follow up' }`.

`createActionImplementer({ access, objects, relationships })` binds
implementations to contracts. Both registries are exported once from `model.ts`
and shared by graph assembly and the binder, so object operations and named
traversals are inferred without a graph import cycle. These are
type/installation context, not read allowlists or permission grants. The runtime
must validate object and relationship identities and vocabulary compatibility at
installation.

`access.forObjects(objects)` binds the same registry once in `graph.ts` and
returns `policy`. Object rules use nested predicates:

```ts
const { policy } = access.forObjects(objects);

policy(Invoice, {
  read: {
    gate: access.role('employee'),
    where: { customer: { portfolio: { eq: access.claims.portfolio } } },
    evidenceMaxAgeMs: 30_000,
  },
  groups: { financial: access.role('finance') },
});
```

This is explicit related-attribute comparison, not delegation to Customer's
entire policy. Binding supplies type context, not permissions. Customer uses a
root portfolio condition; Invoice, AccountReview and Task use their direct
customer references. Validation also checks multi-hop paths. Task reference
consistency is expressed separately by declarative integrity rules. Predicates
require an evidence age bound; role-only policies do not. The declaration shim
checks field names and claim types, including extracted conditions.

Run `node dev/fixtures/customer-graph/validation/check-policies.mjs` to verify
negative policy cases independently, with suppression comments removed in
memory. The
[internal comparison](../../../../relate-internal/docs/internal/relationship-policy-research.md)
retains the path-helper alternative and the removed spike's findings.

Native object policies now include `create`. Review creation requires an
account-manager, a customer in the caller's portfolio, and
`author: { eq: access.actor.id }`. Task creation requires the same role and
portfolio condition. Missing `create` denies native creation; read permission
and action `creates` capabilities do not grant it.

Task also declares reference consistency independently of permission:

```ts
integrity: ({ fields, same }) => [
  same(fields.customer, fields.invoice.customer),
  same(fields.customer, fields.review.customer),
];
```

This callback builds inspectable constraints, not a runtime boolean validator.
The fixture does not expose imperative `validate` or trusted evidence readers.
Run `node dev/fixtures/customer-graph/validation/check-write-policies.mjs` for
the selected write-rule type rejections. The
[internal decision and archived spike](../../../../relate-internal/docs/internal/write-policy-spike.md)
retain the alternatives and behavioral experiment. Runtime enforcement,
validation timing and integrity evidence bounds remain unimplemented/open.

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

## Shared reads

Consumers and action implementations share `get`, `query` and `traverse`. There
is no `list`: `query()` enumerates without a filter, and query options may
contain selection, pagination and equality filters.

```ts
const { objects } = relate.as(principal);

await objects.Customer.query();
await objects.Invoice.query({
  where: { customer: customerId, status: 'open' },
  select: ['id'],
  limit: 100,
});

// Await to-many for one page; iterate it for all records.
await objects.Customer.traverse.invoices(customerId, {
  select: ['status', 'totalMinor'],
  limit: 100,
});

for await (const invoice of objects.Invoice.query({
  where: { customer: customerId, status: 'open' },
  select: ['id'],
  limit: 100,
})) {
  console.log(invoice.id);
}

// To-one returns an object result: ok or not-found.
await objects.Invoice.traverse.customer(invoiceId, { select: ['name'] });
```

`query()` and to-many traversals return an awaitable, async-iterable handle:
`await` returns one page; `for await` yields object records, preserving
evidence, across all pages. Empty non-final pages are followed. Pagination
validation and cycle detection belong to Relate; application bounds such as the
escalation's 1,000 tasks stay explicit. Breaking stops further page requests.
`limit` is a page size, not a total-result bound.

The shared `Page`/`PageMeta` types and `createQuery` helper are implemented in
`@relate/protocol` and `@relate/runtime`. The fixture's `query` operation and
action executor remain declarations; pagination tests do not prove native
transaction rollback. See the
[helper contract](../../../packages/runtime/README.md#pagination).

The same calls work on the `objects` supplied to an action implementation.
Traversal names and cardinality come from the shared relationship definitions;
selected fields belong to the target object. Actions additionally expose their
permitted native writes. Native reads, including queries and traversals, see the
invocation's earlier native writes under the runtime-owned transaction. Source
reads do not join that transaction.

Authorization, field evidence and pagination follow the same contract on both
surfaces. Shared runtime enforcement must protect filters as well as returned
fields; see the
[authorization requirements](./authorization-cases.md#shared-read-enforcement).
The declarations establish typing, not enforcement or query execution.

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
resolve. Graph policies now express portfolio isolation through each child's
customer reference. Invoice read enforcement is implemented; native writes,
native queries and actions remain declaration-only.

The
[current internal decision](../../../../relate-internal/docs/internal/action-authoring.md)
records the minimal-API principle and superseded alternatives. The separate
action-target spike has been removed. Historical research remains in the
internal design docs, not as multiple active APIs in this fixture.

`validation/target.ts` is a temporary import path, not public API packaging.
Authoring source imports no test data. Exact transport errors, transaction
isolation/retries, query coverage and preview eligibility remain open. Do not
implement runtime behavior merely to make these declarations execute.
