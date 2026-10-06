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

A semantic business graph, defined in TypeScript.

Relate is an open-source toolkit for creating a shared, typed view of business
data across APIs and databases. It brings identity, relationships,
authorization, freshness, and provenance into one model so applications and AI
agents can work with operational data through consistent interfaces, while
source systems retain ownership.

Relate aims to make business data easier to understand, connect, and act on
without building another silo.

Created by [Viable Systems](https://viablesystems.ai).

## A small example

CRM owns customers, billing owns invoices, and Relate owns account reviews. With
sources, relationships, and access policies defined in TypeScript, callers work
through one typed graph:

```ts
const { objects, actions } = relate.as(principal);

// Read a customer from CRM using its Relate ID.
const customer = await objects.Customer.get(customerId, { select: ['name'] });

// Follow the relationship to invoices in billing.
const invoices = await objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
});

// Record a review through an authorized action.
const review = await actions.addAccountReview({
  input: { customer: customerId, note: 'Follow up on the open invoice' },
  idempotencyKey: 'review-2026-10',
});
```

This is an API preview from the
[customer graph fixture](dev/fixtures/customer-graph), which contains the model,
connections, policies, and action implementation. The full flow is type-checked
but not yet executable.

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
