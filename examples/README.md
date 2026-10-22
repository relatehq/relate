# Learn Relate by running it

Each example is named after the Relate concept it teaches: native objects,
connected sources, persistence, and datasets. The business scenario inside
(todos, a customer workspace, an ad network) only illustrates that concept.
Future examples should teach a new concept or deployment method rather than
repeat these applications.

Run from a repository checkout with Node 22 (22.16+), 24, or 26 and pnpm 12.9.1
(`npm install --global pnpm@12.9.1`). Run `pnpm install` at the repository root;
each command below builds its dependencies before starting. No published Relate
packages are required.

| Order | Example                                   | Key concepts                                                                                                                                                                        | Run from the repository root     |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 01    | [Native objects](01-native-objects)       | One native object, an action, owner-only access, typed reads and queries. Seeded in-memory app with no external services.                                                           | `pnpm example:native-objects`    |
| 02    | [Connected sources](02-connected-sources) | A business graph across an HTTP CRM, SQLite invoices and native reviews; relationships, role and field policies, receipts, refresh and model inspection in a browser.               | `pnpm example:connected-sources` |
| 03    | [Persistence](03-persistence)             | Persistent storage, explicit migrations, restart recovery, freshness, stale fallback and provider denial. Requires Postgres.                                                        | `pnpm example:persistence`       |
| 04    | [Datasets](04-datasets)                   | Salesforce advertisers, SQLite campaigns and a DuckDB impression log; caller SQL, declared calculations, formulas such as CTR, computed filters/order and column access. Only Node. | `pnpm example:datasets`          |

Every default command builds its dependencies, starts a seeded Inspector, and
opens your browser. Use `--no-open` to print the Inspector link without opening
it. All commands load the root `.env` if present. Keep the command running and
press Ctrl+C to stop; a repeated launch reuses an existing Inspector for that
config.

The scripted SDK walkthroughs remain available separately:

- `pnpm example:native-objects:walkthrough`
- `pnpm example:connected-sources:walkthrough`
- `pnpm example:persistence:walkthrough`

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
[connector guides](../connectors/README.md): SQLite is demonstrated in 02 and
04; DuckDB and a simulated Salesforce org in 04. Stripe has binding guidance in
its connector README. Salesforce scratch-org tooling and opt-in live checks
remain under [dev/salesforce](../dev/salesforce/README.md).

## Examples are for learning, not library fixtures

Edit these applications freely to try ideas. Package and connector tests use
their own definitions and data; `pnpm check:boundaries` enforces that
separation. Tests of each example itself live in its own `test/` folder.

The exploratory application under `dev/fixtures/customer-graph` includes
proposed APIs as well as implemented behavior. Use these examples for runnable
public APIs.
