# Open questions for the async customer graph

Status: **2026-10-06**. This fixture declares the current direction; it does not
implement an executor. Add API concepts only when a concrete example establishes
why ordinary inputs and async object operations are insufficient. See the
[current internal decision](../../../../relate-internal/docs/internal/action-authoring.md).

## Settled authoring direction

- No special action target, mandatory upfront reads or mandatory change builder.
- Inputs carry references or scalar values. Implementations query, branch, write
  supported native objects and return output asynchronously.
- Contracts and colocated action policies remain beside server implementations.
  Object policies stay on the graph; no policy placement redesign here.
- Nested object read predicates use `access.forObjects(objects).policy`, with
  explicit role gates and evidence age bounds. Permission delegation is
  deferred.
- Consumers and actions share `get`, `query` and `traverse`. `query()`
  enumerates without a filter; there is no separate `list` operation.
- The shared binder receives access, objects and relationships for inference.
  Graph assembly reuses both registries; runtime installation validates
  compatibility.
- `creates` is a capability, not authorization. CRM/billing objects stay
  source-owned; their native create methods are unavailable.
- Proposed execution: runtime-owned native transaction, native read-your-writes,
  atomic native effects/receipt. Source operations have separate guarantees.
- Traces describe actual execution. Preview/approval and static workflow
  diagrams need their own concrete requirements, not a mandatory phase for every
  action.

## 1. Authorization and application invariants

Related-attribute predicates now express organization isolation. How does the
runtime resolve trusted policy evidence, handle missing/stale references and
protect reference IDs without accidental policy recursion or data disclosure?
How do action-local checks and reusable native write rules compose without
bypasses? Which checks inspect newly written records, and when must final-state
constraints hold? Keep hidden validation evidence out of implementation results,
errors and traces. The [authorization cases](./authorization-cases.md) specify
outcomes the declared predicates and future write rules must enforce.
Collections, Boolean operators and cyclic/large-model inference remain open; the
fixture selects to-one equality only.

Removing target does not eliminate invocation-specific authorization. A
reference is not a grant. The examples explicitly read referenced objects;
write-only operations and unused reference inputs still need a deliberate policy
contract. Discovery, per-operation checks, final validation and receipt access
are separate.

## 2. Query and evidence semantics

The fixture sketches equality filters and paginated results. Native/reference
filter typing, joins, aggregate pushdown, strict freshness and field
requirements need concrete examples. Do not fetch all rows to implement every
filter locally. Unsupported pushdown needs honest bounded fallback or rejection,
not silently dropped predicates.

Queries must distinguish no matching visible records from unknown filter
evidence or failed enumeration. Define snapshot/pagination consistency,
scan/time budgets, source synchronization coverage and cancellation. `limit` is
a page size, not an atomic-action bound. The escalation's 1,000-task bound is an
application example, not a complete runtime resource policy. Source freshness is
not a native lock.

## 3. Native transaction boundary

Which native isolation level and constraint model support read/write/read and
concurrent actions? How do remote reads interact with an open native
transaction, timeouts and cancellation? Automatic retries must not rerun
non-repeatable external operations. Establish whole-action failure and
output-validation semantics before implementation. Decide when receipts are
retained for failures and how an invocation resumes after a lost response.

Updates/deletes need normal sequential semantics, not the old duplicate-edit
rejection rule. Reference integrity must include newly created records, while
policy still applies to reading one's own writes. Host transaction participation
is not implied.

## 4. Types, input parsing and installation

Reference schemas currently accept string IDs and produce typed `{ id }` values.
Runtime must verify identity and registration; TypeScript cannot validate
supplied IDs. Schema transforms/defaults must run at the intended boundary
exactly once. Create takes schema input; reads expose schema output. Optional
native properties, nullable values and transform examples still need focused
validation.

Installation must verify action IDs/contracts, input reference types, access
vocabulary and object registry identity, including structurally identical
objects with different policies/refinements. Relationship registries must agree
on registered identities, endpoints, reference properties, traversal names and
cardinality. Literal registration tuples remain checked; dynamic registries and
large-graph diagnostics/performance remain open. Read capability restrictions,
if needed, must not become eager fetch declarations.

## 5. Optional preview, external writes and observability

Some features may require an explicit saved proposal. Which actions can offer a
safe preview, and how are approval/expiry/release/state bindings enforced?
Native rollback does not undo arbitrary external effects or make every
implementation previewable. No universal preview API is introduced.

External writes retain intent-before-I/O, idempotency and uncertain-outcome
requirements. Exact operation/output mapping, retry and reconciliation
interfaces are open. A small external action can need more recovery machinery
than a complex native action; that does not imply a second general authoring
API.

Trace supported object operations as they occur, with permission-aware
redaction. Meaningful business-step labels and complete pre-invocation
failure-path diagrams would require additional structure. Add it only for a
concrete feature.

## 6. Errors, packaging and fixture shortcuts

Denied, not-found, invalid, conflict, unsupported and uncertain outcomes need
consistent embedded/HTTP/MCP contracts. Generic throws in examples are
temporary, not selected public error codes. Receipt access, key expiry,
cross-actor replay and actor-dependent output need explicit semantics.

The declaration shim is not a public package import. Server suffixes communicate
intent but do not enforce bundle separation. Source references assume billing
holds CRM keys; aliases/enrichment and unadopted references remain unresolved.
`host.adopt` is setup, not the production synchronization design. Store
ownership must support atomic native writes/receipts, not just cached
observations.
