# Invoice reads and bidirectional traversal

[model.ts](./model.ts) is the executable subset of the customer-graph fixture.
It uses the public packages, with source-owned Customers and Invoices and no
future API declarations. It is design reference only: tests do not import it.
The test suites own an equivalent definition in
[`tests/support/invoice-graph.ts`](../../../../tests/support/invoice-graph.ts)
(`createInvoiceGraph()`) and supply deterministic CRM and billing records
through connectors.

```ts
const customerId = await relate.host.adopt(Customer, 'crm_456');
const invoiceId = await relate.host.adopt(Invoice, 'inv_1');
const invoice = await relate.as(ana).objects.Invoice.get(invoiceId, {
  select: ['customer', 'status', 'totalMinor'],
});
```

The invoice's `customer_id: 'crm_456'` resolves to `customerId`. Ana receives
`customer` and `status` in her portfolio; `totalMinor` is forbidden without
finance. Finance users still cannot read another portfolio's invoices.

Reference lookup never adopts a missing customer. Each nested policy hop
requires fresh retained evidence, even when selecting only the Invoice ID.
Source denial, deletions, missing claims and failed retention cannot establish
permission. Reference IDs are withheld if the target itself cannot be read.
Policy dependency values and raw source keys remain private.

Run the memory acceptance cases:

```sh
pnpm build
pnpm exec vitest run --project unit packages/node/test/references.test.ts
```

The same [contract suite](../../../../tests/support/invoice-read-contract.ts)
runs against Postgres retention with a dedicated existing test database:

```sh
RELATE_TEST_DATABASE_URL=postgres://... pnpm exec vitest run --project integration tests/integration/invoice-read.test.ts
```

The integration setup resets that database's `relate` schema. It tests the
Postgres store, not a live billing provider. Native references, aliases across
additional sources and actions remain outside this implemented subset.

The same relationship now supports both traversal directions:

```ts
const objects = relate.as(ana).objects;
const invoices = await objects.Customer.traverse.invoices(customerId, {
  select: ['status', 'totalMinor'],
});
const customer = await objects.Invoice.traverse.customer(invoiceId, {
  select: ['name'],
});
```

To-many traversal also supports `for await`. Run its shared memory/Postgres
[contract suite](../../../../tests/support/traversal-contract.ts) through
`packages/node/test/traversal.test.ts` or `tests/integration/traversal.test.ts`.
It checks both endpoints, restricted reference fields, pagination, source
reassignment/deletion, expiry during page assembly and retained-value failures.
Enumeration covers adopted graph members; it makes no provider-wide coverage or
cross-source snapshot claim.
