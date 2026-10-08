# Learn Relate by running it

These examples run from a repository checkout. Install dependencies with
`pnpm install` at the repository root; each command below builds the packages
before starting. Use the Node and pnpm versions declared in the root
`package.json`. No published npm packages are required.

The folders are numbered in learning order. If you want to see Relate in an
application first, jump to **03** and return to the smaller examples afterward.

| Order | Example                                                 | What you learn                                                                                                                                                                        | Run from the repository root      |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 01    | [Hello world](01-hello-world)                           | Define a source and object, adopt a record, and perform a typed, authorized read. Prints the result and evidence. No services required.                                               | `pnpm example:hello-world`        |
| 02    | [SQLite customer accounts](02-customer-accounts)        | Connect an actual SQLite table, map source fields, and read records using the embedded SDK. Creates and removes its own temporary database.                                           | `pnpm example:customer-accounts`  |
| 03    | [Interactive customer workspace](03-customer-workspace) | Explore an HTTP CRM customer, SQLite invoices and Relate-owned reviews in a browser. Switch roles, perform an action, replay its receipt, refresh source data, and inspect the model. | `pnpm example:customer-workspace` |
| 04    | [Postgres persistence](04-postgres-persistence)         | Persist observations across runtime restarts and examine freshness, fallback and provider denial. Requires a configured Postgres database.                                            | `pnpm example:postgres`           |

Examples 01–03 use an isolated **in-memory Relate store**. SQLite in 02 and 03
is a **source system**, not Relate's persistence layer. Reviews and observations
in 03 disappear on restart. Example 04 introduces a persistent Relate store.

The exploratory application under `dev/fixtures/customer-graph` includes
proposed APIs as well as implemented behavior. It is not another getting-started
step; use the numbered examples for runnable public APIs.
