# Open questions for the customer graph API

Status: **2026-10-06**. This is a design checklist, not implemented behavior or
permission to expand the runtime. The [source](./source/) is the selected
application shape; [acceptance cases](./acceptance-cases.md) pin required
outcomes. Open API details must not weaken those outcomes.

## Settled direction

- Action contracts and declarative execution policies live in `source/actions/`;
  each implementation lives alongside its contract in a `.server.ts` file.
- `createActionImplementer(access)` configures an application-local binder.
  `implementAction(Action, callback)` binds an implementation to its action. The
  shared access vocabulary supplies types, not grants or a current actor.
- Server composition passes an implementation array directly to
  `createRuntime({ graph, actionImplementations, connections })`. Its signature
  checks coverage and compatibility. Binding uses stable action IDs, not the
  graph's consumer-facing aliases. Literal IDs are retained by `defineAction`.
- Declarative action policy is colocated; missing policy denies discovery and
  execution. Graph-level action-policy overrides are not part of this fixture.
- Synchronous implementation code builds an immutable plan through `changes`.
  Creation assigns native IDs but performs no business writes. Two mutations to
  the same native record reject rather than merge.
- Preview is free of business side effects. Approval, when required, binds the
  proposed effects; execution rechecks permission and relevant conditions.
- Source ownership remains authoritative. The initial external case has one
  external write destination, saved intent and an uncertain outcome when the
  acknowledgement is lost. It does not imply distributed rollback.

## 1. Action authorization beyond a role gate

**Example:** an account manager may escalate only customers in their
organization, and may assign tasks only to an eligible employee.

The current action policy declares only `execute: access.role(...)`. We still
need to decide how declarative rules reference target fields, validated input,
actor claims and declared reads. Object read access does not by itself grant
permission to perform every action on that object.

Custom server-side authorization hooks were proposed for rules that do not fit
inspectable predicates. Their signature, data dependencies, result/error shape
and lifecycle are not selected. In particular, which checks run for discovery,
validation, preview, initial execution and idempotent receipt retrieval?
Discovery without target/input cannot fully evaluate an invocation-specific
rule. Ordinary implementation code must not bypass a declarative denial.

**Decision needed:** a coherent action policy/check contract, with declared data
access and explicit evaluation stages, colocated with the action's server code
where executable logic is necessary. No custom hook API is added yet.

## 2. Authorization of the proposed effects

**Example:** an allowed action proposes a review authored by another user, or a
task linked to another organization's customer.

`creates: [AccountReview, Task]` limits capabilities, not which proposed values
are authorized. How do creation/update/link policies refer to proposed values,
existing values and other new objects in the same plan? Which checks belong to
the action versus the object type, and how do they compose without overrides?

The runtime needs a policy decision before committing effects. Its access to
validation evidence must not become an unauthorized read surface for the
implementation or preview. The fixture's object policies currently expose read
rules, not a complete write-policy authoring API.

**Decision needed:** proposed-state policy authoring and evaluation, including
references between new objects and hidden before-values.

## 3. Business validation versus execution conditions

**Example:** a note must have content, an invoice must still be open, or only
one active review may exist for a customer.

A synchronous implementation can reject an invalid proposal. A check inside that
implementation is not automatically rerun when a saved plan executes. Conditions
that must remain true need an execution representation and enforcement at the
authoritative write. Checking existing row revisions does not detect a new
competing row; a recent provider read is not an atomic provider condition.

**Decision needed:** condition declarations, expected revision/version tokens,
uniqueness/predicate enforcement, conflict responses and unsupported-condition
responses. Do not silently turn a requested guarded write into an unconditional
one. See the conditional-update and concurrent-creation acceptance cases.

## 4. Declared reads and completeness

**Example:** create tasks for every open invoice, including customers with many
pages of invoices, stale source values or fields the actor cannot read.

`reads` currently supplies actor-filtered relationship arrays. It does not yet
express selected fields, filters, required values, freshness, limits, exhaustion
or coverage evidence. The source example only operates on visible invoices; that
must not become a claim about all business invoices.

Should an action reject incomplete evidence, accept explicit degradation, or
operate on a caller-selected set? How are dependent reads expressed within
declared capabilities? How could a business-wide invariant be checked without
exposing hidden rows or implicitly elevating an ordinary implementation?

**Decision needed:** typed read requirements and runtime evidence, including
which observations are informative and which become execution conditions.
Pending edits remain separate from the authorized before-state.

## 5. Policy vocabulary and implementation registration

**Example:** an action uses a role from a different access declaration, or a
separately constructed action has the same ID and TypeScript shape but different
schema refinements or policy behavior.

Literal IDs and tuples catch common missing, duplicate and foreign bindings.
They do not establish runtime definition identity. `ActionPolicy` currently
stores a broad role-gate type; using `access.role` rejects unknown names for
that vocabulary, but does not prove a rule belongs to the graph installing it.

**Decision needed:** compilation/installation checks for role and claim
compatibility, duplicate action IDs/aliases, contract/release compatibility and
forged registrations. Also open: dynamic implementation arrays and narrow
per-action claim requirements. The current binder uses the whole shared access
vocabulary; it is not global state. Large-registry type performance and mismatch
diagnostics have not been established by the small binding spike.

## 6. Sealed plans, IDs and schema transforms

**Example:** mutate a values object after `build`, return an ID never created,
reuse a builder, or submit a plan from another invocation.

The selected behavior is immutable effects and output, with runtime provenance
and validation. The TypeScript brand is not that enforcement. Exact sealing,
copying/serialization, invocation identity and validation ordering are open. The
persisted format must contain data and stable identifiers, not schema instances,
object definitions or deferred callbacks.

How are Zod input/output transforms applied once, and which representation is
hashed and persisted? How are native ID allocation, aborted allocations,
reference integrity and output validation handled? Strings alone do not prove an
ID belongs to the right object type or to this plan.

**Decision needed:** the serialized plan envelope and validation lifecycle. Do
not confuse ordinary create-time IDs with future preallocated empty handles for
circular new objects.

## 7. Saved previews, approval and changing policy

**Example:** an approval expires, a role is revoked, an action is redeployed, or
relevant customer state changes between preview and execution.

Execution must not silently substitute a newly calculated proposal. We still
need the exact input/target/effect/state/release bindings, expiry, current
policy checks and redacted preview shape. Approval is optional application
policy, not an automatic user prompt for every action.

**Decision needed:** storage and verification APIs, material-drift rules,
canonical hashing, retention and historical release compatibility. A hash is not
authorization. Current access checks must also protect stored receipts.

## 8. Update, delete and relationship identity

**Example:** update a reference property and also edit the relationship it
backs; assign two different employees to one review; change an assignment's role
and effective date.

One mutation per actual native record is agreed. Distinct edges may share an
endpoint without being duplicate mutations. Reference-backed links and explicit
edge records need a normalized mutation identity so aliases cannot evade the
rule. Attributed relationships, parallel edges and cardinality still need an API
and storage-independent contract.

**Decision needed:** update/delete/link capability declarations, edge identity,
owned versus source-backed mutations, and final-state validation semantics. The
first fixture exercises complete native creations, not these APIs.

## 9. External uncertainty and output

**Example:** CRM commits an update, but Relate loses its acknowledgement or
crashes before saving the receipt.

Saved intent precedes the provider call; missing confirmation does not prove
failure or that nothing was submitted. Remaining choices include submission
claims, connector idempotency capabilities, conclusive reconciliation evidence,
provider conditions, receipt output mapping and projection-refresh status.
Observing the desired value is not necessarily proof this invocation caused it.

**Decision needed:** one-destination execution/recovery contracts and output
mapping. Provider-generated IDs needed by a later write require a separate
multi-step design. Compensation is not implied by this fixture.

## 10. Public packaging, errors and fixture shortcuts

**Example:** a browser imports an action contract, or a consumer retries a
denied invocation using an old receipt key.

Which package exports the graph-aware runtime and server binder? How do we
verify that shared imports exclude `.server.ts` implementations and server-only
dependencies? The filename convention alone does not enforce a bundle boundary.
`validation/target.ts` is a temporary declaration shim, not the intended public
import path.

Denied, not-found, invalid, conflict, unsupported and uncertain outcomes need
consistent embedded/HTTP/MCP contracts without leaking hidden information.
Receipt retention and idempotency-key expiry also need explicit semantics.

The fixture assumes billing stores CRM IDs and uses `host.adopt` for setup.
Alias/enrichment resolution, unadopted reference results and synchronization
remain to be expressed in this authoring example; unresolved identity must not
be silently treated as a new or writable native object.

## Deferred directions

Circular new-object handles, queries over pending edits, automatic routing of
oversized actions, host transaction participation and multi-destination
compensation remain open directions. They are not part of the current fixture
and do not block its bounded native-creation path. Initially reject oversized
atomic actions against an explicit limit; the limit is still undecided. Do not
silently chunk and change atomicity or approval semantics.

Resolve these questions with concrete acceptance scenarios and focused type or
runtime evidence as appropriate. The broader rationale and system references
remain in
[internal action planning](../../../../relate-internal/docs/internal/action-planning.md)
and [write execution](../../../../relate-internal/docs/internal/writes.md).
