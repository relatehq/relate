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
[hello world](../../../examples/01-hello-world/README.md) and
[`typed-read.test.ts`](../../../packages/node/test/typed-read.test.ts). The full
fixture still uses declarations for its broader native/query/action surface. The
[native account-review slice](../../../packages/node/NATIVE_ACTIONS.md) now
executes real package definitions, get/create, authorization, rollback and
successful and declared-failure receipt storage against memory and Postgres.
Source-backed references, nested read policies and bidirectional
Customer–Invoice traversal are executable in the Invoice read subset.

## Current authoring direction

The [receipt contract and caller examples](./receipts.md) cover completion,
lookup, lost-response recovery and changed access. Native success/failure
lookup/replay now executes through the packages, bound to the originating actor
and current access. Background acceptance is deferred for exploration; the full
fixture's broader operations and nonportable error-detail schemas remain
unimplemented.

Actions declare input/output schemas, optional domain-error schemas, creation
capabilities and colocated execution policies. Adjacent `.server.ts`
implementations are asynchronous: query objects when needed, branch, perform
supported writes, and return output. There is no special action target, upfront
read declaration or change builder.

```text
source/
  access.ts                         shared role/claim vocabulary
  model.ts                          objects, shared object/relationship registries
  graph.ts                          assembly and object policies
  app.ts                            server runtime composition
  actions/
    add-account-review.ts           input reference and action contract
    add-account-review.server.ts    authorized lookup and native creation
    escalate-account.ts             escalation contract
    escalate-account.server.ts      conditional query, native read/write/read
    review-invoice.ts               invoice reference input
    review-invoice.server.ts        lookup using an ID from an earlier result
validation/
  target.ts                         temporary declaration-only API shim
  rejections.ts                     positive and negative type probes
  action-errors.ts                  declared failure and Receipt type probes
  receipts.ts                       receipt identity and typed lookup probes
  receipt-scenario.ts               completion, recovery and revoked-access cases
  policies.ts                       nested policy inference and rejection cases
  write-policies.ts                 create and integrity type cases
  check-write-policies.mjs          independent write-rule rejection check
  check-policies.mjs                independent unsuppressed rejection check
  scenario.ts                       intended outcomes, never executed
  reference-write-scenario.ts       write identity, permission and rollback cases
  setup.ts                          simulated connections and principals
  records.ts                        provider data
```

`referenceInput(Customer)` parses a nonblank string into
`ObjectId<'business.customer'>`, with no `{ id }` wrapper. Typed invocation
input is `{ customer: customerId, note: 'Follow up' }`, and implementations use
`objects.Customer.get(input.customer)` directly. External request data goes
through schema parsing; typed calls require branded IDs. Parsing does not load
the object, establish its actual type or existence, or authorize access.

Own IDs, reference fields, create values and results, query filters, and both
traversal directions preserve the corresponding object brand. Action output
schemas use `referenceInput(AccountReview)` and `referenceInput(Task)` too, so
receipt IDs remain typed. Storage and JSON still contain ordinary strings.

`implementAction(graph, AddAccountReview, fn)` binds a server implementation to
its contract and infers the access vocabulary, object operations and named
traversals directly from the graph. No separate binder or registry wiring is
needed: `graph.ts` imports only action contracts, which depend on model/access
definitions, so server implementations can import the graph without an import or
type-inference cycle. `app.ts` registers the implementations separately.

Graph context supplies types, not permission grants. Runtime installation still
must validate action contracts, object and relationship identities, and
vocabulary compatibility when installing implementations.

`defineGraph` infers object policies from its `objects` and `access` inputs.
Every object key needs an explicit `read` decision; use `read: 'deny'` where
access is intentionally denied. Object rules use nested predicates:

```ts
defineGraph({
  id: 'example',
  objects: { Customer, Invoice },
  relationships: {},
  actions: {},
  access,
  policies: {
    Customer: { read: 'deny' },
    Invoice: {
      read: {
        gate: access.role('employee'),
        where: { customer: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
  },
});
```

This is explicit related-attribute comparison, not delegation to Customer's
entire policy. Registry membership supplies type context, not permissions.
Customer uses a root portfolio condition; Invoice, AccountReview and Task use
their direct customer references. Validation also checks multi-hop paths. Task
reference consistency is expressed separately by declarative integrity rules.
Predicates require an evidence age bound; role-only policies do not. The
declaration shim checks field names and claim types, including extracted
conditions.

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
retain the alternatives and behavioral experiment. The native account-review
slice enforces create policies at the write and before commit. Task integrity
rules and their evidence bounds remain unimplemented/open.

`createRuntime({ graph, actionImplementations, connections })` checks action
registration. `creates` limits native creation capability; runtime policies
still must authorize the values and relationships. Source-owned objects have no
native `create` operation. Source-backed reads are not part of the native
transaction.

The intended native execution contract is one runtime-owned transaction:
interleaved native reads see earlier writes, success commits effects and
receipt, and failure rolls back native effects. This now executes in the
account-review slice; the full fixture still contains unimplemented operations.
There is no author-facing commit call or mandatory preview.

Expected business failures use `errors: { code: schema }` on the shared contract
and typed `fail(code, details)` in the implementation. Escalation declares
`inactive` and `tooManyInvoices`; callers narrow the failed receipt's error
kind, code and details. Runtime failures stay separate and do not expose raw
exception messages. See [declared action failures](./action-errors.md) for the
agreed contract and rollback, replay and uncertainty requirements. The
declaration types are checked; execution and persistence remain unimplemented.

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
`@relate/protocol` and `@relate/runtime`. Graph queries now execute through
public packages on memory and Postgres, including native action queries and
rollback. The full escalation scenario and action traversal remain fixture
declarations. See the
[helper contract](../../../packages/runtime/CONTRACT.md#pagination).

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
customer reference. Invoice reads and the first native account-review action are
implemented. Native queries, escalation, declared failures and receipt
lookup/recovery remain declaration-only.

The
[current internal decision](../../../../relate-internal/docs/internal/action-authoring.md)
records the minimal-API principle and superseded alternatives. The separate
action-target spike has been removed. Historical research remains in the
internal design docs, not as multiple active APIs in this fixture.

`validation/target.ts` is a temporary import path, not public API packaging.
Authoring source imports no test data. Exact transport errors, transaction
isolation/retries, query coverage and preview eligibility remain open. Do not
implement runtime behavior merely to make these declarations execute.
