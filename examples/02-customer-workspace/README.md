# 02 · Customer workspace

Explore one account across an HTTP CRM, a SQLite billing database, and
Relate-owned account reviews. The browser shows actual SDK results and lets you
inspect their evidence; the accompanying inspector shows the graph definitions.

From the repository root:

```sh
pnpm install
pnpm example:customer-workspace
```

This opens a seeded Inspector for Customer, Invoice and AccountReview. Select
Ana or Fin to explore their access and run actions. Use `--no-open` to print the
link without opening a browser; Ctrl+C stops the owned Inspector.

## Custom browser application

```sh
pnpm example:customer-workspace:app
```

This builds the packages, starts the CRM simulator, seeds a temporary SQLite
billing database, starts the application and a seeded model inspector, and opens
your browser. No credentials or database server are required. Both listeners
choose available loopback ports. Use
`pnpm example:customer-workspace:app --no-open` to print the links without
opening a browser. Ctrl+C closes the application, connectors, simulator and
owned inspector process, then removes the temporary database. State resets on
each launch. A second launch starts its own application and reuses the existing
model inspector; stopping that second launch leaves the borrowed inspector
running. Stop the original owner to close the inspector. A second Ctrl+C forces
a stuck shutdown; shutdown also has a six-second limit.

The launcher loads the repository root `.env` if it exists, preserving variables
already exported in your shell. Put `ANTHROPIC_API_KEY` there to enable the
inspector's built-in agent. Without a key, the example and seeded graph still
work, but the agent is unavailable. Restart an existing inspector after changing
the key; reusing its URL does not reload its environment.

## Try it in this order

1. Start as **Ana**, an account manager. Inspect Mothlight's two invoices. Ana
   can see invoice amounts and currency, but customer revenue is withheld.
2. Switch to **Fin**, who can see customer revenue but cannot see invoice
   amounts or currency, or add reviews.
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
  connector bindings, native action implementation and SDK calls.
- [src/seed.ts](src/seed.ts): shared adoption of the demo customer and two
  invoices into the supplied runtime.
- [src/crm-connector.ts](src/crm-connector.ts): HTTP source adapter. The shared
  repository CRM simulator supplies deterministic provider responses. The
  adapter intentionally remains local (as in example 03), so the provider
  simulator stays independent of Relate and each example includes its own
  connector code.
- [src/server.ts](src/server.ts): a small example-specific HTTP surface, input
  validation, two fixed demo principals and local request restrictions.
- [src/ui](src/ui): dependency-free browser interface with native HTML controls.
- [src/index.ts](src/index.ts): terminal entry and browser opening.
- [src/launcher.ts](src/launcher.ts): cancellation and bounded shutdown.
- [src/inspector.ts](src/inspector.ts): CLI child ownership and complete-line
  bootstrap URL parsing.
- [relate.config.ts](relate.config.ts): `defineApp` and `seed` exports for
  `relate dev --seed`; importing the config starts nothing.

The SQLite connection uses `@relate/connector-sqlite`, with a stable application
connection ID and explicit selected columns. SQLite owns invoices; Relate's
memory store owns observations, reviews and receipts. Billing's customer
reference contains the CRM record ID. This example does not demonstrate
cross-source key matching or multi-source enrichment.

Native-reference traversal is not implemented yet. The example keeps the IDs
returned by successful review actions and calls `objects.AccountReview.get` for
each ID, applying read authorization on every request. This small in-memory
index is temporary demo application state, not a general Relate query API.
Reviews created outside this running example's action wrapper will not appear.
The UI and call panel label this limitation explicitly.

The host adopts the known seed records explicitly. This is not a source scan or
a general customer query API. The role selector chooses from two server-owned
demo principals (the graph's development `principals`); it is not production
authentication. The HTTP routes are local to this example, not a public Relate
transport.

The model inspector runs the same `defineApp` as a second runtime, with its own
CRM simulator, billing database and memory store. Its `/mcp` endpoint serves
`?as=ana` or `?as=fin`; `relate dev` prints the `claude mcp add` command. That
runtime is separate from the browser application: reviews added in one do not
appear in the other. The launcher passes `--seed`, so both runtimes start with
Mothlight (`crm_456`) and invoices `INV-1042` (overdue, GBP 4,800) and
`INV-1043` (paid, GBP 1,250). The inspector reruns the seed after each accepted
code change. Repeated seeding reuses those records' graph identities within the
same runtime; it does not add duplicate customers or invoices. Reviews start
empty and can be created through `addAccountReview` as Ana.

To run only the seeded inspector with the repository's `.env` loaded, start from
the repository root:

```sh
pnpm build
pnpm exec dotenvx run -f .env -- pnpm relate dev --config examples/02-customer-workspace/relate.config.ts --seed --open
```

In its Agent page, ask to list customers and their invoices, or use the printed
MCP command. Both can see invoice statuses; only Ana can see amounts and
currency. Omitting `--seed` starts the providers but leaves graph membership
empty. If an inspector is already running without seeding, stop it before
launching with `--seed`.

For durable Relate state, continue to
[03 · Postgres persistence](../03-postgres-persistence). Return to the
[ordered examples](../README.md).
