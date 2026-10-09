# Contributing

Dependency updates use the latest stable releases, with exact versions retained
in manifests and the lockfile. Check with `pnpm outdated -r`; keep duplicated
runtime dependencies aligned across packages and examples.

Use TypeScript 6.0.3, the latest stable 6.x release, for builds, typechecks,
ESLint, and dependency-boundary checks. This is the current exception to the
latest-major policy: the tooling still requires the TypeScript 6 JavaScript API.
Keep one TypeScript dependency until the tooling supports the new API.

Supported Node lines are 22 (22.16.0 or newer), 24 and 26. `.node-version`
selects the preferred contributor version, not a requirement to upgrade. The
minimum is Node 22.16 because the SQLite connector uses `timeout` and
`isTransaction`. Keep `@types/node` on the oldest supported major to catch
accidental use of newer APIs. CI exercises current releases of Node 22, 24 and
26, plus separate checks for the declared minimums: 22.16.0, 24.0.0 and 26.0.0.
Each checks installation, builds, runtime tests, installed packages and
onboarding commands. Repository policy checks, including dependency boundaries,
run once on current Node 26.

Install pnpm explicitly with `npm install --global pnpm@12.9.1`; Corepack is not
required. The package-manager pin keeps dependency installation reproducible
across supported Node versions.

## Dependency ownership

Keep shared tooling (TypeScript, Vitest, ESLint, Prettier, Changesets) at the
workspace root. Root tests and scripts also declare the dependencies they
import. Each package declares its own implementation dependencies; provider SDKs
and drivers belong to their connector under `connectors/<provider>`.

Runnable applications belong under `examples/*` as private workspace packages.
Independent provider simulators belong under `dev/simulators/*` as private
workspace packages with their own dependencies and no Relate imports. Consumers
import simulators by package name, not by reaching into their directories.
Design declarations and acceptance material remain under `dev/fixtures`.

Provider connectors live under `connectors/<provider>`. SQLite, Stripe and
Salesforce are current read-only connectors; each owns its provider-specific
transport, identity, resource-selection, and error behavior. Application object
models, mappings and policies belong in runnable numbered examples, not in the
connector packages. See `examples/02-customer-accounts`,
`examples/03-customer-workspace`, and `examples/05-salesforce` for current
compositions. SQLite source access is separate from Relate's own persistence
adapters.

## Package boundaries

Run `pnpm check:boundaries` when changing imports or adding a workspace package.
The checker discovers packages through pnpm's workspace configuration, including
scaffolds with no source yet. Each package must have an explicit policy in
`tests/architecture/package-boundaries.ts`; declaring a dependency in
`package.json` does not grant architectural permission to import it.

Production TypeScript and JavaScript files are checked throughout each package,
including root entry points and TSX. Tests and generated output are excluded;
production code cannot import excluded code to bypass the checks. The Postgres
example imports its provider simulator through the private workspace package
`@relate/dev-crm-simulator`.

The `relate` authoring entry point must not reach the compiler, even through
helpers, re-exports or type imports. `relate/model` can depend on model helpers
under `src/model/`, but must not reach authoring or compiler modules. Runtime
module ownership is enforced separately by
`tests/architecture/runtime-boundaries.ts`. Boundary regression tests exercise
the CLI against temporary workspaces without changing the checkout.

## Postgres integration tests

Provision an existing, dedicated test database using your own Postgres server
(for example, one running in Docker), then run:

```sh
RELATE_TEST_DATABASE_URL=postgresql://localhost/relate_test pnpm test:integration
```

The URL includes the database name. The role must own the `relate` schema or
have permission to create it. The suite drops that schema before and after the
run and applies migrations during setup; use a disposable test database. Other
schemas are left alone. Integration files run serially because they share the
schema and inject database triggers. Do not run separate test commands against
the same test database concurrently.

`pnpm test` and `pnpm check` also require `RELATE_TEST_DATABASE_URL`.
`pnpm test:unit` needs no database. Tests never fall back to `DATABASE_URL`,
create databases, or start/stop Postgres. Compose provisioning can be added
later without changing this contract.

## Parallel work in worktrees

Each Git worktree is a separate checkout on its own branch, with its own
`node_modules`, build output, and databases. Use them to develop several
features at once without the test runs or schemas colliding.

```sh
pnpm worktree:create feat/receipt-lookup   # ../relate-worktrees/receipt-lookup
pnpm worktree:list
pnpm worktree:delete receipt-lookup        # name, branch, or path
```

`worktree:create` derives the folder and database names from the branch, which
must start with a Conventional Commit type such as `feat/` or `fix/`. It then:

1. Creates the branch from local `main` (`--base origin/main` leaves out
   unpushed commits), or checks out the branch if it already exists.
2. Copies the main checkout's `.env`, changing `DATABASE_URL` to
   `relate_receipt_lookup` and `RELATE_TEST_DATABASE_URL` to
   `relate_receipt_lookup_test` on the same Postgres server.
3. Creates those two databases, runs `pnpm install`, and runs `pnpm build`.

`worktree:delete` drops the two databases, removes the worktree, and deletes the
branch if it is merged into `main`. It refuses a worktree with uncommitted
changes unless you pass `--force`, and it only drops databases named
`relate_<name>` and `relate_<name>_test` on a local server. Use `--keep-branch`
to keep a merged branch. Both commands accept `--dry-run`.

Delete worktrees with `worktree:delete`, not `git worktree remove`, so their
databases do not accumulate.
