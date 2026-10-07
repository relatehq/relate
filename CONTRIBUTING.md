# Contributing

Placeholder, we will fill in later.

Dependency updates use the latest stable releases, with exact versions retained
in manifests and the lockfile. Check with `pnpm outdated -r`; keep duplicated
runtime dependencies aligned across packages and examples.

Use TypeScript 6.0.3, the latest stable 6.x release, for builds, typechecks,
ESLint, and dependency-boundary checks. This is the current exception to the
latest-major policy: the tooling still requires the TypeScript 6 JavaScript API.
Keep one TypeScript dependency until the tooling supports the new API.

Use Node 26.9.0 from `.node-version`. `@types/node` 26.6.4 is the latest
published Node 26 type package at this update; its version does not exactly
match the runtime's version. Keep the runtime and types on the same major when
upgrading.

## Package boundaries

Run `pnpm check:boundaries` when changing imports or adding a workspace package.
The checker discovers packages through pnpm's workspace configuration, including
scaffolds with no source yet. Each package must have an explicit policy in
`tests/architecture/package-boundaries.ts`; declaring a dependency in
`package.json` does not grant architectural permission to import it.

Production TypeScript and JavaScript files are checked throughout each package,
including root entry points and TSX. Tests and generated output are excluded;
production code cannot import excluded code to bypass the checks. The Postgres
example has an explicit exception for its provider simulator.

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
