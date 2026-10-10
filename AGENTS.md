## Development versions and releases

Relate is in development mode. Do not add changesets, bump package versions,
enter prerelease mode, or run release preparation/publication as part of feature
PRs. Keep all public packages at `0.0.0-dev.0`; explain changes in the PR
instead. Preserve breaking-change and migration guidance in
`DEVELOPMENT_NOTES.md` without adding a Changeset. `pnpm check:development`
enforces this in CI. Release commands are disabled by
`scripts/releases/policy.json`. Enabling releases requires an explicit owner
request and a separate reviewed change to that policy and release documentation.
Package build and installed-tarball tests remain part of ordinary validation;
they do not publish packages.

## Commit messages

Use Conventional Commits: `<type>[optional scope]: <description>` (for example,
`docs: update license documentation` or `feat(runtime): add durable reads`).
Mark breaking changes with `!` after the type or scope.

Do not add AI attribution to commits or pull requests. No `Co-Authored-By`
trailers for Claude, Codex, or any other agent, and no "Generated with" lines or
other notes saying an agent wrote, committed, or reviewed the change.

## Pull request descriptions

Write PR descriptions so a non-technical reader can understand why the PR was
created and what changes for someone using the product.

- Lead with the user problem or need and why this change matters.
- Explain the product behavior with concrete before-and-after examples: who is
  doing what, what happened before, and what happens after this change.
- For bug fixes, describe the specific situation that triggers the bug, the
  incorrect result the user experiences, and the corrected outcome. For example:
  "When a customer has no invoices, opening their account failed. Their account
  now opens and shows an empty invoice list, so the team can still review the
  customer."
- For features, show a concrete task the change enables or improves. For
  example: "A support agent can now see a customer's invoices alongside their
  account reviews, so they can investigate a billing question in one place."
- Use plain language and explain necessary technical terms. Put implementation
  details and validation after the product explanation; a list of changed files
  or technical mechanisms does not explain why the PR exists.
- Keep examples accurate to the change's actual scope. If there is no direct
  user-visible change, say so and explain the concrete maintenance or
  reliability reason without inventing a product benefit.

## Worktrees

When asked to do work in a new worktree, or to work on several features in
parallel, create one with `pnpm worktree:create <type>/<name>` from any checkout
(for example, `pnpm worktree:create feat/receipt-lookup`). It creates
`../relate-worktrees/<name>` with its own branch, `.env`, databases,
dependencies, and build. Then do all work, tests, and commits inside that
folder.

- Do not use `git worktree add` directly, copy `.env` files, or create databases
  by hand.
- Remove a worktree only when asked, with `pnpm worktree:delete <name>`. It
  drops the worktree databases and deletes the branch only if it is merged.
  Never pass `--force` without explicit approval: it discards uncommitted work.
- `pnpm worktree:list` shows each worktree's branch, uncommitted changes, and
  database.
- Details: `CONTRIBUTING.md`, "Parallel work in worktrees".

## Keeping the owner in the loop

I want to follow how the system evolves in detail, not just get summaries. When
you discuss, propose, or report on design or implementation work, show the
concrete thing being talked about rather than describing it abstractly:

- **Code snippets:** the actual types, functions, or SQL in question, before and
  after when something changes.
- **APIs:** the public surface as a caller would use it, with a short usage
  example (authoring calls, consumer calls, HTTP requests, MCP tools).
- **Contracts:** interfaces, result and evidence shapes, protocol types, and
  invariants each side relies on.
- **Module splits:** which package or module owns what, what moved where, and
  the dependency direction between them.
- **Key files:** paths (`packages/<pkg>/src/...:line`) for the files that carry
  the change, so I can open them directly.

Apply this to plans, design options, progress updates, and final summaries
alike. When weighing alternatives, show each option as code or a contract
sketch, then give a recommendation. If something is still undecided, say so
explicitly and show the open shape. Keep prose short; let the examples carry the
explanation.

## Test ownership and setup

Packages, connectors, apps, and their tests must not depend on `examples/` or
`dev/fixtures/`. Examples are tutorials and documentation for users learning and
experimenting with Relate; dev fixtures are exploratory design material. Neither
is setup for library tests: a user or contributor must be able to change an
example's code or data without breaking any package test.
`pnpm check:boundaries` enforces this for source, tests, shared test helpers,
and workspace dependency declarations, including type-only imports. Packaging
smoke tests write their own consumer programs rather than copying an example.

Use arrange–act–assert: each test explicitly creates the state it needs,
performs the operation, and asserts the outcome. Avoid module-level fixture
instances or hidden setup coupling. Small test-owned helpers are encouraged: a
nearby `createCustomerGraph()` can return fresh definitions or a factory can
create a runtime in the required state. Shared cross-package acceptance
factories belong in `tests/support`; they must not import example code. Register
cleanup for each test's owned resources.

Keep unit tests with their owning package or application in its `test/` folder.
Tests of an example (checking that the tutorial itself still works) belong in
that example's `test/` folder; they are the only tests that import example code.

## Repository scope and sources of truth

This repository is the OSS Relate implementation. Do not change the sibling
`relate-internal` repository unless the owner explicitly includes it in the
task.

Treat exported package source, package contracts, and executable tests as the
source of truth for implemented behavior. Use the root `README.md` status table
and public docs to distinguish current product behavior from planned work.
`dev/fixtures` and `relate-internal` may inform a design, but they can contain
proposals, declaration shims, or historical scenarios. A typechecking fixture is
not proof of execution, authorization, atomicity, persistence, or durability.

When a public contract changes, update its owning package documentation and the
public docs or examples that teach it. Record breaking-change and migration
guidance in `DEVELOPMENT_NOTES.md` while releases remain disabled.

## Architecture and ownership

Keep dependencies aligned with the policies in
`tests/architecture/package-boundaries.ts` and
`tests/architecture/runtime-boundaries.ts`. Declaring a workspace dependency
does not grant permission to import it.

| Area                                               | Responsibility                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/relate`                                  | Portable authoring, compilation, public model/result types, the browser-safe typed consumer facade (`relate/consumer`), and connector/storage contracts. The `relate` and `relate/consumer` entry points must remain independent of the compiler and Node runtime. |
| `packages/protocol`                                | Transport-safe request, result, evidence, discovery, receipt, and error shapes shared across consumer boundaries.                                                                                                                                                  |
| `packages/runtime`                                 | Authorization, reads, traversal, queries, actions, evidence, transactions, and runtime-owned execution.                                                                                                                                                            |
| `packages/node`                                    | Node composition, lifecycle, source bindings, action implementations, and binding the engine to `ConsumerOperations` per principal (`as` returns the `relate/consumer` facade over it).                                                                            |
| `packages/postgres`                                | Postgres persistence and migrations behind runtime storage contracts.                                                                                                                                                                                              |
| `packages/client`, `packages/http`, `packages/mcp` | Remote client or transport surfaces over the protocol `ConsumerOperations` contract; their presence does not imply that a planned interface is complete.                                                                                                           |
| `packages/cli`, `apps/inspector`                   | Local development workflow and Inspector UI/server integration.                                                                                                                                                                                                    |
| `connectors/*`                                     | Provider-specific system/resource access through `relate/connectors`; connectors do not own application graphs or policies.                                                                                                                                        |
| `examples/*`                                       | Runnable, user-facing learning applications built only from public APIs.                                                                                                                                                                                           |
| `tests/support`                                    | Shared test-owned models and acceptance-contract factories for package and persistence implementations.                                                                                                                                                            |
| `dev/simulators`, `dev/salesforce`                 | Independent provider-development tooling. Keep application models and public behavior out of these tools.                                                                                                                                                          |
| `dev/fixtures`                                     | Exploratory design evidence only; never a public API or library-test dependency.                                                                                                                                                                                   |

Prefer completing behavior through a real public application path over widening
declaration-only surfaces. Keep portable graph/app authoring separate from Node
execution and provider tooling. Provider access denial must remain distinct from
temporary unavailability and must never authorize stale data.

## Validation

Use focused checks while iterating, then validate in proportion to the affected
contract:

- Run the owning package, connector, application, or example tests for local
  behavior changes.
- Run `pnpm check:boundaries` after changing imports, entry points, package
  ownership, or workspace declarations.
- Run `pnpm test:onboarding` when changing installation or example startup.
- Run `pnpm test:packaging` when changing public exports, builds, or packed
  package behavior.
- Run `pnpm check` before completing a repository-wide implementation change. It
  requires the disposable Postgres database configured by
  `RELATE_TEST_DATABASE_URL`; use `pnpm test:unit` when no test database is
  available and report that limitation explicitly.

Do not claim a full check passed when only a focused command ran. Preserve the
exact failure output when an environment dependency prevents validation.
