# 03 · Interactive customer workspace

Explore one account across an HTTP CRM, a SQLite billing database, and
Relate-owned account reviews. The browser shows actual SDK results and lets you
inspect their evidence; the accompanying inspector shows the graph definitions.

From the repository root:

```sh
pnpm install
pnpm example:customer-workspace
```

This builds the packages, starts the CRM simulator, seeds a temporary SQLite
billing database, starts the application and model inspector, and opens your
browser. No credentials or database server are required. Both listeners choose
available loopback ports. Use `pnpm example:customer-workspace --no-open` to
print the links without opening a browser. Ctrl+C closes the application,
connectors, simulator and owned inspector process, then removes the temporary
database. State resets on each launch.

## Try it in this order

1. Start as **Ana**, an account manager. Inspect Northwind's two invoices.
   Amounts are withheld by Relate's financial field policy.
2. Switch to **Fin**, who can see the amounts but cannot add reviews.
3. Switch back to Ana and add a review. Expand **Action receipt** to see the
   action's returned result.
4. Click **Retry last submission**. The original input and idempotency key are
   reused, returning the same receipt without creating a second review.
5. Edit the CRM customer name and click **Update CRM**, then **Refresh from
   sources**. The updated name comes through the HTTP connector.
6. Open **Inspect model** to explore Customer, Invoice, AccountReview, their
   properties and relationships. Editing `src/graph.ts` reloads that model.
   Restart the example to activate code changes in the running application.

Expand **Relate calls** and **Read results & evidence** to connect the screen
with the embedded SDK operations. Field availability and evidence are returned
by Relate; the browser never reads the CRM or SQLite directly.

## Code map

- [src/graph.ts](src/graph.ts): sources, objects, references, relationships,
  field policies and the `addAccountReview` action definition.
- [src/app.ts](src/app.ts): deferred setup with `defineApp`, SQLite seeding,
  connector bindings, native action implementation, host adoption and SDK calls.
- [src/crm-connector.ts](src/crm-connector.ts): HTTP source adapter. The shared
  repository CRM simulator supplies deterministic provider responses.
- [src/server.ts](src/server.ts): a small example-specific HTTP surface, input
  validation, two fixed demo principals and local request restrictions.
- [src/ui](src/ui): dependency-free browser interface with native HTML controls.
- [src/index.ts](src/index.ts): application and inspector process lifecycle.
- [relate.config.ts](relate.config.ts): side-effect-free graph export for the
  CLI.

The SQLite connection uses `@relate/connector-sqlite`, with a stable application
connection ID and explicit selected columns. SQLite owns invoices; Relate's
memory store owns observations, reviews and receipts. Billing's customer
reference contains the CRM record ID. This example does not demonstrate
cross-source key matching or multi-source enrichment.

Native-reference traversal is not implemented yet. The example keeps the IDs
returned by successful review actions and calls `objects.AccountReview.get` for
each ID, applying read authorization on every request. This small in-memory
index is demo application state, not a general Relate query API.

The host adopts the known seed records explicitly. This is not a source scan or
a general customer query API. The role selector chooses from two server-owned
demo principals; it is not production authentication. The HTTP routes are local
to this example, not a public Relate transport. The model inspector compiles
these same definitions without attaching to the example's runtime.

For durable Relate state, continue to
[04 · Postgres persistence](../04-postgres-persistence). Return to the
[ordered examples](../README.md).
