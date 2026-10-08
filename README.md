<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/relate-logo-dark.svg">
    <img alt="Relate" src="assets/brand/relate-logo-light.svg" height="48">
  </picture>
</h1>

> [!WARNING]
>
> Relate is at a very early stage and is not ready for use. It is published only
> for comment and discussion. The current package version is `0.0.0-dev.0`.

See [RELEASING.md](RELEASING.md) for versioning and the release procedure.

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

The keys in `objects` are the canonical API names: `Customer` becomes
`apiName: 'Customer'` in the compiled model and `objects.Customer` in the SDK.
An object's `id` is its stable definition identity and stays the same across
renames. Changing a registry key renames the public API; changing a label only
changes its presentation.

`label`, `pluralLabel`, and `description` are optional metadata for UIs,
documentation, and agents. The singular label defaults to the humanized API name
(`AccountReview` → `Account Review`); the plural label defaults to that singular
label without guessing plurals. Supply collection labels such as `Customers` or
`People` explicitly. Descriptions stay absent when omitted. See
[object naming and migration details](packages/relate/CONTRACT.md#object-names-and-display-metadata).

**4. Use it from code.** Reads are typed, filtered by the caller, and carry
freshness evidence.

```ts
import { connect } from 'relate';
import { createRuntime } from '@relate/node';

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
> Postgres storage run today. Native get/create actions wait for completion and
> support declared business failures and actor-bound receipt lookup/replay.
> Multi-source enrichment, broader actions, and MCP remain API previews.

Native actions support
[portable value constraints and declared business failures](packages/node/NATIVE_ACTIONS.md#declared-business-failures).
For example, `z.string().min(1).max(4000)` keeps review notes nonempty and
bounded on both action input and native storage; the compiled model exposes
these limits. An action declaring `errors: { inactive: z.object({}) }` can call
`fail('inactive', {})` to return a typed failure receipt after rolling back its
native writes. Authorized retries recover the same outcome without repeating the
handler. Malformed requests and pre-acceptance denial remain typed rejections.

## Get started

From a checkout, open the
[interactive customer workspace](examples/03-customer-workspace):

```sh
pnpm install
pnpm example:customer-workspace
```

Explore a customer from an HTTP CRM, invoices from SQLite, and Relate-owned
account reviews. Switch roles, add a review, retry its action, refresh source
data, and open the model inspector. No credentials or database server are
needed; state resets on restart.

Follow the [numbered examples](examples/README.md) in learning order, starting
with `pnpm example:hello-world` for the smallest terminal example.

For a smaller SQLite source example, run `pnpm example:customer-accounts`. It
reads CRM customers with portfolio access checks and a Stripe customer key
through [`@relate/connector-sqlite`](connectors/sqlite).

Stripe billing records are available through
[`@relate/connector-stripe`](connectors/stripe), using
`stripe({ apiKey, apiVersion, mode }).resource('customers', { fields: ['name'] })`.
It supports verified account/mode identity and read-only lookups of customers,
invoices, subscriptions, products, prices, payment intents, and charges.

For the [Postgres example](examples/04-postgres-persistence), copy
`.env.example` to `.env` and configure separate `relate` and `relate_test`
databases on your local server. The example values use Postgres on port 5433.
Relate manages its schema and migrations, not database or server provisioning.

`pnpm example:postgres`, `pnpm test:integration`, and `pnpm test` load the root
`.env` using dotenvx. Existing shell variables take precedence. `DATABASE_URL`
is for the persistent example; `RELATE_TEST_DATABASE_URL` is exclusively for
integration tests, which reset that database's `relate` schema. Keep `.env`
untracked. `pnpm test:unit` needs no database or environment file.

## Inspector

`pnpm relate dev` serves a local [inspector](apps/inspector) that draws your
model as a live graph of objects, sources and relationships. It redraws on save
and shows compile problems next to the last good model. For now it covers the
model graph; more screens will follow.

<p align="center">
  <img alt="The Relate inspector showing Customer, Invoice and AccountReview objects and their relationships" src="assets/readme/inspector-light.svg" width="800">
</p>

## License

Relate is licensed under the [Apache License 2.0](LICENSE).
