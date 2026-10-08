# 02 · SQLite customer accounts

A local CRM backed by SQLite, read through `@relate/connector-sqlite` and the
typed Relate application API. No external services or credentials are needed.

From the repository root:

```sh
pnpm install
pnpm example:customer-accounts
```

The script seeds a temporary SQLite database, adopts two customer IDs, and reads
Northwind as an employee assigned to its portfolio. It checks that the other
portfolio's customer is hidden (`not-found`), then closes the app and deletes
the temporary database. The output includes the customer name, Stripe customer
ID, and Relate's field evidence.

- `src/model.ts`: source schema, Customer object and portfolio access policy.
- `src/app.ts`: explicit SQLite column selection and asynchronous connection
  disposal through `defineApp`.
- `src/seed.ts`: provider schema and sample data.
- `src/index.ts`: typed adoption and authorized reads.

SQLite owns customer data. Relate uses its default in-memory store here, so
adopted IDs and observations do not survive app shutdown. The application owns
source identity through `connectionId: 'local-crm'`; the database needs no
account table. Keep that ID when relocating the same CRM and change it for a
different logical source. See the connector’s
[optional database verification](../../connectors/sqlite/README.md#optional-database-verification)
if you need to detect an accidental database replacement.

The CRM includes a nullable `stripe_customer_id` column. Its example value is
synthetic. A later Stripe connector can add billing sources and relationships to
this graph using that key; this example makes no Stripe calls and does not yet
model invoices or subscriptions.

See the [ordered examples](../README.md) for the full learning path.
