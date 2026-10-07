## Commit messages

Use Conventional Commits: `<type>[optional scope]: <description>` (for example,
`docs: update license documentation` or `feat(runtime): add durable reads`).
Mark breaking changes with `!` after the type or scope.

Do not add AI attribution to commits or pull requests. No `Co-Authored-By`
trailers for Claude, Codex, or any other agent, and no "Generated with" lines or
other notes saying an agent wrote, committed, or reviewed the change.

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

## Implementation approach

We are building the OSS external version of relate here, using what we have
designed and learnt from the `relate-internal` package. Here is our plan of
action:

**Build the new implementation using the prototype as a behavioral reference,
selectively porting proven pieces.** We’ve learned enough to improve the
structure, but rewriting every algorithm would risk losing correctness already
worked out.

The useful distinction is **what behavior to preserve versus what implementation
to preserve**.

**Implement agreed behavior through complete application paths**

Use the existing neutral model:

- API-owned customers.
- Postgres-owned invoices.
- Relate-owned account reviews.
- Relationships between them.
- An authorized read and a native action.

The customer-graph acceptance fixture has established the intended application
API. Source-backed reads, references and traversal already execute through the
packages. The first native `addAccountReview` path now also executes get/create,
authorization, rollback and successful receipt storage on memory and Postgres.
Receipt lookup/replay, durable pending execution and declared failure receipts
remain subsequent slices. Do not keep expanding a declaration-only API instead
of implementing agreed behavior.

For each authorized slice:

- Implement the public API in its owning packages and exercise it through real
  package imports. Use the fixture to identify required behavior, not as a
  second implementation or a permanent public API declaration.
- Keep authoring/type tests in `packages/relate/test`, execution tests in
  `packages/runtime/test`, and typed application tests in `packages/node/test`.
  Share memory/Postgres acceptance cases in `tests/support`, with database
  execution in `tests/integration`.
- Replace covered declarations in
  `dev/fixtures/customer-graph/validation/target.ts` with package
  imports/re-exports as their complete contract becomes available. Keep any
  remaining proposed capability explicitly marked unimplemented.
- `dev/` may retain exploratory examples, application fixtures and simulators.
  Typechecking a proposed API is useful design evidence, but is not proof of
  execution, authorization, atomicity or durability. Moving files alone is not
  an implementation milestone.
- Complete one end-to-end behavior before broadening the API. The first native
  action path is `addAccountReview`: real definitions/compilation, authorized
  native creation, reference validation, transaction rollback and a successful
  receipt. Durable pending execution, receipt lookup/recovery and external
  effects are subsequent slices, not implicit requirements to build now.

Package responsibilities along these paths:

| Order | Build                    | What it establishes                                                    |
| ----- | ------------------------ | ---------------------------------------------------------------------- |
| 1     | `relate` \+ `protocol`   | Authoring API, compiled model, public results and evidence             |
| 2     | `runtime` \+ `postgres`  | One complete embedded read and native-write path with real durability  |
| 3     | `http` \+ `client`       | The same behavior through a remote interface                           |
| 4     | `mcp`                    | The same operations exposed to agents                                  |
| 5     | `node`                   | Typed embedded composition now; startup/workers as those features land |
| 6     | `cli` \+ `create-relate` | A polished workflow around APIs that already work                      |

Compose the embedded path through `node` while implementing it; do not postpone
the callable application API until after transports. This is an implementation
sequence, not a reduction of the product vision. Grow capabilities through those
paths rather than trying to finish each package independently.

**What I would take from the prototype**

The most valuable material is its **behavioral scenarios and regression
evidence**:

- Authorization filtering and avoiding private-data leakage.
- Stale fallback and freshness evidence.
- Observation ordering and checkpoint atomicity.
- Identity and relationship integrity.
- Action idempotency, uncertain outcomes, and recovery.
- Migration integrity and installed-package compatibility.

Adapt these into tests against the new public interfaces. Keep expected outcomes
independently understandable; tests should not merely compare the new engine
with whatever the prototype happens to return.

I would also selectively port well-understood algorithms, schemas, and SQL after
checking their ownership and dependencies. There is little value in inventing a
different implementation of a correct concurrency rule just to call it a
rewrite.

**What I would implement more cleanly**

- **Public interfaces:** deliberate authoring, consumer, and extension contracts
  instead of carrying forward every experimental integration export.
- **Composition:** portable app definitions separated from Node hosting and
  local development tooling.
- **Observation handling:** shared pure logic with clear ownership, rather than
  resolution reaching into synchronization internals.
- **Runtime organization:** smaller operations and explicit capability
  interfaces instead of growing the prototype’s large runtime files.
- **Persistence boundaries:** module-owned operations and explicit transaction
  coordination, preserving the prototype’s atomicity guarantees.
- **Compilation:** keep authoring imports separate from compiler/platform
  dependencies.

Those are targeted improvements supported by what we observed. I would avoid
building speculative abstractions for every future platform before we have a
second implementation to validate them.
