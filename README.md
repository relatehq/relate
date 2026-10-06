<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/relate-logo-dark.svg">
    <img alt="Relate" src="assets/brand/relate-logo-light.svg" height="48">
  </picture>
</h1>

> [!WARNING]
>
> Relate is at a very early stage and is not ready for use. It is published only
> for comment and discussion.

**A semantic business graph, defined in TypeScript.**

Relate is an open-source toolkit for creating a shared, typed view of business
data across APIs and databases. It brings identity, relationships,
authorization, freshness, and provenance into one model so applications and AI
agents can work with operational data through consistent interfaces, while
source systems retain ownership.

Relate aims to make business data easier to understand, connect, and act on
without building another silo.

Created by [Viable Systems](https://viablesystems.ai).

## Example

A CRM API owns customers. Stripe knows their revenue. A billing database owns
invoices. Relate composes them into one graph, with access rules attached.

**1. Describe the sources.** Each system keeps ownership of its records.

```ts
const crm = defineSource({
  id: 'crm.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string(), region: z.string() }),
});

const stripe = defineSource({
  id: 'stripe.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), crm_id: z.string(), mrr: z.number() }),
});

const billing = defineSource({
  id: 'billing.invoices',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    customer_id: z.string(),
    status: z.string(),
  }),
});
```

**2. Compose objects and relationships.** One `Customer`, two systems.

```ts
const access = defineAccess({
  roles: ['sales', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: { region: z.string() },
});

const Customer = defineObject({
  id: 'customer',
  label: 'Customer',
  pluralLabel: 'Customers',
  description: 'Customer accounts with CRM and billing information.',
  membership: source(crm),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: from(crm.fields.name, { id: 'customer.name' }),
    region: from(crm.fields.region, { id: 'customer.region' }),
    mrr: from(stripe.fields.mrr, {
      id: 'customer.mrr',
      match: stripe.fields.crm_id, // preview: enrichment from a second source
      access: access.groups.financial,
    }),
  },
});

const Invoice = defineObject({
  id: 'invoice',
  label: 'Invoice',
  pluralLabel: 'Invoices',
  membership: source(billing),
  properties: {
    id: objectId({ id: 'invoice.id' }),
    customer: reference(Customer, {
      id: 'invoice.customer',
      from: billing.fields.customer_id,
    }),
    status: from(billing.fields.status, { id: 'invoice.status' }),
  },
});

const CustomerInvoices = defineRelationship({
  id: 'customer.invoices',
  forward: 'invoices',
  reverse: 'customer',
  via: Invoice.properties.customer,
});
```

**3. Set permissions.** Sales see their region. Only finance sees revenue.

```ts
const graph = defineGraph({
  id: 'business',
  objects: { Customer, Invoice },
  relationships: { CustomerInvoices },
  access,
  policies: {
    Customer: {
      read: {
        gate: access.role('sales'),
        where: { region: { eq: access.claims.region } },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: access.role('finance') },
    },
    Invoice: {
      read: {
        gate: access.role('sales'),
        where: { customer: { region: { eq: access.claims.region } } },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});
```

**4. Use it from code.** Reads are typed, filtered by the caller, and carry
freshness evidence.

```ts
const relate = createRuntime({
  graph,
  connections: [
    connect(crm, crmApi),
    connect(stripe, stripeApi),
    connect(billing, billingDb),
  ],
});

const { objects } = relate.as({
  id: 'ana',
  roles: ['sales'],
  claims: { region: 'emea' },
});

await objects.Customer.get(id, { select: ['name', 'mrr'] }); // mrr withheld: Ana is not finance
await objects.Customer.traverse.invoices(id, { select: ['status'] }); // CRM → billing
```

**5. Or hand it to an agent.** The same graph, the same rules, over MCP
(preview):

```ts
serveMcp(relate, { principal: (req) => authenticate(req) });
```

The agent gets `get`, `query`, `traverse`, and action tools for each object. It
sees only what the authenticated caller may see.

Writes go through typed, authorized, idempotent actions. See the
[customer graph fixture](dev/fixtures/customer-graph) for actions and
Relate-owned records.

> **Status:** single-source objects, references, traversal, policies, and
> Postgres storage run today. Multi-source enrichment, actions, and MCP are API
> previews.

## Get started

From a checkout, run the [smallest working example](examples/hello-world):

```sh
pnpm install
pnpm example:hello-world
```

It defines a source and object, adopts a record, and performs an authorized read
using an in-memory store. No database or credentials are needed.

For the [Postgres example](examples/postgres-persistence), copy `.env.example`
to `.env` and configure separate `relate` and `relate_test` databases on your
local server. The example values use Postgres on port 5433. Relate manages its
schema and migrations, not database or server provisioning.

`pnpm example:postgres`, `pnpm test:integration`, and `pnpm test` load the root
`.env` using dotenvx. Existing shell variables take precedence. `DATABASE_URL`
is for the persistent example; `RELATE_TEST_DATABASE_URL` is exclusively for
integration tests, which reset that database's `relate` schema. Keep `.env`
untracked. `pnpm test:unit` needs no database or environment file.

## License

Relate is licensed under the [Apache License 2.0](LICENSE).
