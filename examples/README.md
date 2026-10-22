# Learn Relate by running it

These examples have distinct jobs: the smallest application, a fuller business
application, persistent deployment, and analytical datasets. Future examples
should teach a new concept or deployment method rather than repeat these
applications.

Run from a repository checkout with Node 22 (22.16+), 24, or 26 and pnpm 12.9.1
(`npm install --global pnpm@12.9.1`). Run `pnpm install` at the repository root;
each command below builds its dependencies before starting. No published Relate
packages are required.

| Order | Example                                         | Key concepts                                                                                                                                                          | Run from the repository root      |
| ----- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 01    | [Todo notes](01-todo-notes)                     | One native object, an action, owner-only access, typed reads and queries. Seeded in-memory app with no external services.                                             | `pnpm example:todo-notes`         |
| 02    | [Customer workspace](02-customer-workspace)     | A business graph across an HTTP CRM, SQLite invoices and native reviews; relationships, role and field policies, receipts, refresh and model inspection in a browser. | `pnpm example:customer-workspace` |
| 03    | [Postgres persistence](03-postgres-persistence) | Persistent storage, explicit migrations, restart recovery, freshness, stale fallback and provider denial. Requires Postgres.                                          | `pnpm example:postgres`           |
| 04    | [Customer events](04-customer-events)           | Correlated event datasets, caller SQL, declared calculations, computed filters/order and field access. Requires only Node.                                            | `pnpm example:customer-events`    |

Every default command builds its dependencies, starts a seeded Inspector, and
opens your browser. Use `--no-open` to print the Inspector link without opening
it. All commands load the root `.env` if present. Keep the command running and
press Ctrl+C to stop; a repeated launch reuses an existing Inspector for that
config.

The scripted SDK walkthroughs remain available separately:

- `pnpm example:todo-notes:walkthrough`
- `pnpm example:customer-workspace:walkthrough`
- `pnpm example:postgres:walkthrough`
- `pnpm example:customer-events:walkthrough`

These print results and exit. Each walkthrough starts its own runtime separate
from any running Inspector.

Start with 01 to read the smallest app, or 02 to explore a complete business
scenario in the browser. Examples 01, 02 and 04 use isolated **in-memory Relate
stores**. SQLite in 02 is a **source system**, not Relate's persistence layer.
Example 03 persists Relate state in Postgres.

Preparation prints a short status line, followed by results or browser URLs.
Build failures and runtime errors remain visible. Add `--verbose` for full build
logs, or `--no-open` to keep an example from opening a browser. Press Ctrl+C to
stop that app and its owned processes.

Provider-specific setup belongs in the
[connector guides](../connectors/README.md): SQLite is demonstrated in 02;
Stripe and Salesforce have binding guidance in their connector READMEs.
Salesforce scratch-org tooling and opt-in live checks remain under
[dev/salesforce](../dev/salesforce/README.md).

## Examples are for learning, not library fixtures

Edit these applications freely to try ideas. Package and connector tests use
their own definitions and data; `pnpm check:boundaries` enforces that
separation. Tests of each example itself live in its own `test/` folder.

The exploratory application under `dev/fixtures/customer-graph` includes
proposed APIs as well as implemented behavior. Use these examples for runnable
public APIs.
