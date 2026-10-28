# 2026-10-28: Action adoption

**Status:** implementation added 2026-10-28. The public API, local atomicity
rule and contract below were agreed after review the same day. Shared
memory/Postgres action tests live in
`tests/support/adoption-action-contract.ts`; prepared-memory rollback tests live
in `packages/runtime/test/action-adoption.test.ts`. Integration helpers remain
deferred. This feature must ship before the
[media agency benchmark](./2026-10-23-media-agency-benchmark.md) is built,
because its create-type tasks depend on it.

| Part                                                                     | Status                                                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `adopts` declaration and `objects.Type.adopt(id)` in handlers            | Agreed 2026-10-28                                                                                |
| Adoption commits or rolls back with the action's local changes           | Agreed 2026-10-28                                                                                |
| No exactly-once claim for external writes; recovery is integration code  | Agreed 2026-10-28                                                                                |
| Commit-time acceptance with a pending-object overlay                     | Agreed 2026-10-28, see [How adoption commits](#how-adoption-commits-with-the-action)             |
| Same-view rule: a newer identical observation does not abort             | Agreed 2026-10-28, see [Ordering at commit](#ordering-at-commit)                                 |
| Storage capability, acceptance and conflict validation                   | Agreed 2026-10-28, see [Storage contract](#storage-contract)                                     |
| Query visibility, failure receipts and invocation provenance             | Agreed 2026-10-28, see [Behavior rules](#behavior-rules)                                         |
| Waiting for a just-created record to become readable is integration code | Agreed 2026-10-28, see [Records that are not yet fetchable](#records-that-are-not-yet-fetchable) |
| `waitMs` option and a typed connector absence signal                     | Deferred, see [Deferred](#deferred-typed-absence-and-waitms)                                     |
| SDK helpers for integration journals and visibility polling              | Deferred, see [Deferred](#deferred-integration-helpers)                                          |

## The problem

An action handler can call a platform API to create something, such as a TikTok
ad group, but it cannot turn the new platform record into a Relate object. The
handler therefore cannot return a reference to what it created, and the caller
cannot read it through the graph.

```ts
implementAction(graph, LaunchAdGroup, async ({ objects }) => {
  const created = await tiktok.createAdGroup({ name: 'NL_ACME_Q4_RTG_TIKTOK' });
  // created.adgroup_id === 'tt_123'. Now what?
  // objects.TikTokAdGroup has get() and query() only: no way to register tt_123.
  return { adGroupId: ??? };
});
```

Relate can already register (adopt) a source record, but only through a trusted
host call made outside any action:

```ts
// packages/node/src/runtime.ts:396, today
const id = await app.host.adopt(graph.objects.TikTokAdGroup, 'tt_123');
```

The handler cannot simply call `host.adopt()`:

- it is not available in the handler context, by design: it is a host privilege,
  not a principal's;
- it commits on its own (`ObservationStore.accept`,
  `packages/postgres/src/index.ts:276`). If the action then fails, the adoption
  stays, so a failed action would leave behind a new graph member that nothing
  references.

This spec adds adoption as an action capability that commits **with** the
action's other local changes.

## Concepts

Read these in order; each builds on the previous ones.

| Term                    | Meaning                                                                                                                                   | Tiny example                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Source object**       | An object whose data lives in an external system and is fetched through a connector.                                                      | `TikTokAdGroup`, `membership: source(adGroups)`                                |
| **Native object**       | An object whose data Relate stores itself, created only by actions.                                                                       | `MediaChange`, `membership: native()`                                          |
| **Membership**          | The set of records that belong to an object type in this graph. A source record is not a member until it is adopted.                      | `tt_123` exists in TikTok but is not yet a `TikTokAdGroup`                     |
| **Relate ID**           | The stable ID Relate assigns to a member, distinct from the platform's own ID. A random UUID (v4), so IDs carry no time order.            | `9b1d…-…` for platform record `tt_123`                                         |
| **Source identity**     | One external record in a graph/object/source scope, connection, resource, account and partition. Adoption reuses this full key.           | `(graph, AdGroup, source, connection, resource, account, partition, 'tt_123')` |
| **Provider account**    | The external account a source binding is verified against. A record from another account is a different identity.                         | TikTok advertiser `adv_42`                                                     |
| **Observation**         | One fetched copy of a source record: raw fields, mapped values, fetch time and an ordering token.                                         | `tt_123` at budget `500`, token `918`                                          |
| **Acceptance**          | Storing an observation if it is newer than the stored one. Adoption is acceptance that also creates membership.                           | `store.accept(scope, { adopt: true, observation })`                            |
| **Adoption**            | Registering a source record as a member, assigning (or reusing) its Relate ID, and retaining its first observation.                       | `host.adopt(TikTokAdGroup, 'tt_123') → id`                                     |
| **Native transaction**  | The database transaction an action runs in. Native writes, the receipt and feed entries commit together or not at all.                    | `store.native.transaction(scope, …)`                                           |
| **Graph lock**          | Postgres serializes all native transactions of one graph. While one action runs, every other action in that graph waits.                  | `pg_advisory_xact_lock(['native', graphId])`                                   |
| **Receipt**             | The saved result of one action invocation, keyed by the caller's idempotency key; replays return it.                                      | `{ state: 'succeeded', output: { adGroupId } }`                                |
| **Feed**                | The durable, ordered list of business changes (created, adopted, updated…), written atomically with the change.                           | `{ kind: 'adopted', object: TikTokAdGroup/9b1d… }`                             |
| **Idempotency ID**      | A stable ID for one logical action call, derived from the caller's key. Handlers pass it to external systems or journals.                 | `ctx.idempotencyId`                                                            |
| **External write**      | A call from a handler to a platform API. It is outside every Relate transaction.                                                          | `POST /adgroup/create/`                                                        |
| **Integration journal** | Application code that records external operations by idempotency ID so a retry can find what an earlier attempt did. Not part of the SDK. | `journal.once(idempotencyId, create, { recover })`                             |
| **Pending object**      | An object adopted during a running action that is not yet committed. Visible only inside that invocation.                                 | `adopt('tt_123')` returns an ID usable until the action ends                   |
| **Overlay**             | The invocation's pending objects and observations, consulted before committed storage. It also holds staged updates to existing members.  | `get(id)` reads the staged budget before commit                                |
| **Acceptance conflict** | The identity or observation used by the action can no longer be committed as validated; the action must retry.                            | A host refresh has already stored a newer deletion                             |
| **Same view**           | A committed observation that is newer than the staged one but has identical state, raw fields and mapped values. It is not a conflict.    | Consumer refresh at token `920` saw the same budget `500`                      |

## How actions work today

```mermaid
sequenceDiagram
  participant C as Caller
  participant X as Executor (runtime)
  participant T as Native transaction
  participant H as Handler
  participant S as Source store
  C->>X: invoke(action, input, idempotencyKey)
  X->>T: BEGIN, lock graph, claim key
  X->>H: run handler(ctx)
  H->>S: objects.X.get(id): refresh commits independently
  H->>T: objects.Native.create(values)
  H-->>X: output
  X->>X: recheck input/output references, validate created records
  X->>T: save receipt, stage feed
  X->>T: COMMIT
```

Key facts from the source:

- The handler runs **inside** the native transaction, including any external
  calls it makes (`packages/runtime/src/actions/execute.ts:261`).
- Postgres takes a graph-wide lock for the whole transaction
  (`['native', graphId]`, `packages/postgres/src/native.ts:190`), so actions in
  one graph run one at a time. **Every second a handler spends waiting on a
  platform is a second no other action in that graph can start.** The memory
  store serializes the same way (`packages/runtime/src/native-memory.ts:124`).
- Reads of source objects inside a handler use the committed source store, not
  the transaction. A refresh during the handler commits immediately on another
  connection (`packages/runtime/src/resolution/refresh.ts:155`,
  `packages/runtime/src/native-memory.ts:17`: "observation refreshes are
  independently retained").
- Source acceptance holds a per-record lock and promises "No I/O under this
  lock" (`packages/postgres/src/index.ts:291`).
- Any failed operation, even one the handler catches, aborts the invocation
  (`run()` in `execute.ts:326`). Only calls that go through the context (`get`,
  `query`, `create`, and now `adopt`) are wrapped this way; the handler's own
  platform calls are not.
- A declared failure (`fail(code)`) rolls back a savepoint and saves a failed
  receipt. A thrown error or timeout rolls back everything and saves no receipt,
  so the key stays unclaimed and a retry runs the handler again.

## The API

Actions declare what they adopt, next to what they create:

```ts
const LaunchAdGroup = defineAction({
  id: 'launch-ad-group',
  input: z.object({
    campaign: referenceInput(TikTokCampaign),
    name: z.string(),
    budget: z.number(),
  }),
  output: z.object({ adGroupId: referenceInput(TikTokAdGroup) }),
  adopts: [TikTokAdGroup], // NEW. Optional; `creates` becomes optional too.
  errors: {
    notFound: z.object({}),
    notVisible: z.object({ externalId: z.string() }),
  },
});

implementAction(
  graph,
  LaunchAdGroup,
  async ({ input, objects, idempotencyId, fail }) => {
    const campaign = await objects.TikTokCampaign.get(input.campaign, {
      select: ['externalId'],
    });
    if (campaign.status !== 'ok') return fail('notFound', {});

    // Integration code: create in TikTok, or recover what an earlier attempt created.
    const { adgroup_id } = await createOrRecoverAdGroup(idempotencyId, {
      campaignId: campaign.data.externalId,
      name: input.name,
      budget: input.budget,
    });

    // Integration code: TikTok serves a new ID before its read API can return
    // the record. Poll with the integration's own client; this is not a context
    // call, so a failed attempt can be caught and turned into a declared failure.
    if (!(await tiktok.waitForAdGroup(adgroup_id, { timeoutMs: 5_000 })))
      return fail('notVisible', { externalId: adgroup_id });

    // NEW: register tt_… as a TikTokAdGroup in this action's transaction.
    const { id } = await objects.TikTokAdGroup.adopt(adgroup_id);

    const group = await objects.TikTokAdGroup.get(id); // reads the pending object
    return { adGroupId: id };
  },
);
```

Types:

```ts
// packages/relate/src/index.ts — new, next to NativeMembership (line 266)
export type SourceMembership = ReturnType<typeof source>;

// packages/relate/src/actions.ts (sketch)
type NativeObject = ObjectDefinition & { readonly membership: NativeMembership };
type SourceObject = ObjectDefinition & { readonly membership: SourceMembership };

export interface ActionDefinition<
  …,
  Creates extends readonly NativeObject[] = readonly NativeObject[],
  …,
  Adopts extends readonly SourceObject[] = readonly SourceObject[],
> {
  readonly creates: Creates; // frozen [] when omitted
  readonly adopts: Adopts;   // frozen [] when omitted
}

// Added to ActionContext.objects[K] only when G['objects'][K] extends A['adopts'][number]:
adopt(
  sourceRecordId: string,
): Promise<{ readonly id: ObjectId<G['objects'][K]['id']> }>;
```

- `adopt` returns `{ id }`, like native `create()`. `host.adopt()` keeps
  returning a bare ID.
- `creates` and `adopts` are both optional in `defineAction` and both default to
  a frozen empty tuple. Today `creates` is required (`actions.ts:60`); making it
  optional is a small authoring change that keeps the two declarations
  symmetric. `defineAction` infers the exact readonly tuple, so omitting
  `adopts` grants no object an `adopt` method. The broad interface defaults
  exist for generic constraints only.
- `actionKeys` (`actions.ts:28`) gains `'adopts'`; otherwise `defineAction`
  rejects the option with `action.invalid-shape`.
- `SourceMembership` replaces the ad-hoc `{ membership: { resource: unknown } }`
  shape that `host.adopt` uses today (`packages/node/src/runtime.ts:397`), so
  both entry points constrain adoption targets the same way.

## Behavior rules

### Declaration

- `adopts` accepts only registered source objects; `creates` stays native-only.
  Both are checked at compile time (`packages/relate/src/compiler.ts:890`) and
  in the manifest (`packages/relate/src/model.ts:1071`), with a new
  `action.invalid-adopts` diagnostic.
- `adopt` exists only on declared targets, enforced by the handler type and at
  runtime (`ActionError('denied')`, as for undeclared `create`).
- Discovery lists `adopts` next to `creates` on `ActionDescription`
  (`packages/protocol/src/discovery.ts:198`), so agents know what an action can
  bring into the graph. The HTTP, client and MCP surfaces pass the field through
  wherever they re-validate or re-serialize descriptions.

### Identity

- Adoption uses the object's configured source binding. It cannot choose a
  different connection, resource or provider account.
- If the record is already a member, `adopt` returns its committed ID and stages
  a fresh observation. If not, the runtime assigns a new Relate ID that the
  invocation uses until commit.
- The first staged ID is fixed for the invocation. Repeated or concurrent
  adoption of the same identity returns that ID; a later host adoption with a
  different ID causes `unavailable`, never substitution of an ID already used in
  native records or output.
- Overlay keys contain every `StorageScope` field plus `sourceRecordId`
  (`packages/relate/src/storage.ts:21`). A second index uses scope plus Relate
  ID for `get` and canonical reference lookup. Identical provider keys in
  different object types or bindings never share an entry.
- Per-identity staging is serialized within the invocation. Fetches may run
  concurrently, but publication compares observations using `compareObservation`
  (`packages/runtime/src/observations/ordering.ts:14`), not completion order. An
  older response cannot replace a newer staged observation. Conflicting ordering
  evidence aborts the invocation; it is not silently overwritten.

### Authorization

- The action's execute policy and the binding's provider-account check apply
  first.
- After fetching, the runtime evaluates the caller's object policy on the
  fetched observation. If the caller could not read the object, `adopt` fails as
  `not-found` and all staged work is discarded. Adoption never grants read
  access.
- Output references are rechecked as today, against the pending object, with
  current provider-account verification and policy evidence bounds. Adoption
  does not authorize related objects or fields implicitly.

### Reads inside the handler

- `get`, `query`, native-reference validation and policy dependency resolution
  see pending objects through the same invocation-local overlay.
- Other invocations and consumers do not see a pending object. After commit it
  is an ordinary member, subject to normal authorization and freshness.
- Pending observations age normally. `refresh: true`, an expired `maxAgeMs`, or
  expired policy evidence triggers a fetch into the overlay, preserving its ID.
  This uses the ordinary read and authorization rules; it never calls the
  independently committing `ObservationStore.accept` for a staged identity.
  Fetches allocate their own tokens and retain their actual fetch-start times.
- Failed refreshes follow ordinary stale-data controls, but cannot authorize
  with expired evidence. Explicit provider denial or confirmed deletion cannot
  fall back to a previously readable observation. Adoption itself requires a
  present, readable fetch and has no stale fallback.
- Full evidence for staged source fields reports retention and ordering as
  `unconfirmed`, with the existing corresponding warnings, until commit. The
  backing store's durability is not a promise that staged data has been saved.
- Final reference validation may refresh the overlay before acceptance. Once
  acceptance begins the overlay is sealed: no more reads or source I/O. This
  preserves the current bounded-evidence authorization model; it does not claim
  a snapshot of external systems or prevent changes after commit.

### Queries and pagination

Source queries currently enumerate committed members, whereas native queries
scan the transaction (`packages/runtime/src/queries/query.ts:249`). Action
queries must merge the committed source scan with the overlay for the requested
scope before filtering or projecting:

1. Include newly staged members. For existing members, replace the committed
   candidate with its staged observation, including changes that make it enter
   or leave the query predicate.
2. Deduplicate by scoped source identity and Relate ID. Conflicting IDs for one
   identity abort with `unavailable`; never expose both versions.
3. Preserve the existing bytewise Relate-ID ordering, scan bounds, authorization
   and page-size rules. Because Relate IDs are random, a pending ID can fall
   anywhere in that order, so this is a true sorted merge of the committed page
   and the sorted pending list, never an append. Apply `after` to the merged
   candidate stream; do not append pending records after a full committed page
   or count duplicates twice.
4. Keep cursors invocation-scoped, as today
   (`packages/runtime/src/queries/cursors.ts:31`). These are live keyset pages,
   not a snapshot: records adopted between pages at or before `after` are not
   revisited. Start a new query after further adoptions to enumerate the full
   resulting membership. Ordinary refreshes can also change predicate matches.

```ts
const { id } = await objects.TikTokAdGroup.adopt(adgroup_id);
const group = await objects.TikTokAdGroup.get(id);
const groups = objects.TikTokAdGroup.query();
// Enumerating groups includes id if it matches and remains authorized.
```

### Records that are not yet fetchable

Platforms often return an ID before the record can be read. `adopt` fetches
through the object's connector once; if the connector cannot return the record,
the adoption fails and, like every failed context call, aborts the invocation.

**Waiting for visibility is integration code, not an `adopt` option.** The
handler's own platform client is outside the executor's abort-on-error wrapper,
so it may poll, catch and decide:

```ts
// Integration code, before adopt. Any client and any retry policy.
const visible = await tiktok.waitForAdGroup(adgroup_id, { timeoutMs: 5_000 });
if (!visible) return fail('notVisible', { externalId: adgroup_id });
const { id } = await objects.TikTokAdGroup.adopt(adgroup_id);
```

Why this instead of a `waitMs` option on `adopt`:

| Concern                                         | Integration polling                         | `waitMs` on `adopt` (rejected for v1)                                  |
| ----------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Who must classify "not yet visible" vs "denied" | The integration, which knows its platform   | Every connector, through a new typed error                             |
| Works with existing connectors                  | Yes                                         | No: a generic 404 error is never retried                               |
| Author can declare the outcome                  | Yes: `fail('notVisible', …)` with a receipt | No: `adopt` aborts with an untyped `not-found`, no receipt             |
| Caller can tell "retry later" from "bad input"  | Yes, by declared error code                 | No: same `not-found` code as a missing input reference                 |
| Changes read semantics of existing members      | No                                          | Yes: a typed absence would have to decide stale fallback for all reads |

If the connector still cannot fetch the record after the integration saw it (for
example a different replica), `adopt` surfaces the connector failure as
`unavailable`. The key stays unclaimed, the caller retries, and the journal
recovers the external record. The deferred `waitMs` design is kept in
[Deferred](#deferred-typed-absence-and-waitms) in case the benchmark shows this
retry is too common.

**Cost of waiting.** The whole handler, polling included, runs under the graph
lock. Keep visibility polls short, and say so in the public docs. A handler that
polls for five seconds blocks every other action in that graph for five seconds.
The action deadline (`actionTimeoutMs`, at most 60 s) still bounds the whole
invocation.

| `adopt` outcome                                    | Effect on the invocation                 |
| -------------------------------------------------- | ---------------------------------------- |
| Record fetched and readable by the caller          | Returns `{ id }`                         |
| Caller cannot read it                              | Aborts with `ActionError('not-found')`   |
| Record is deleted at the source                    | Aborts with `ActionError('not-found')`   |
| Source denies the provider account                 | Aborts with `ActionError('denied')`      |
| Connector error (including a not-yet-visible 404)  | Aborts with `ActionError('unavailable')` |
| Fetch timeout or action deadline reached           | Aborts with `ActionError('unavailable')` |
| Invalid source ID, or fetched record fails mapping | Aborts with `ActionError('invalid')`     |

### Provenance

- A new adoption is attributed to the action's actor and invocation ID, like a
  native `created` record.
- Re-adopting an existing member does not replace its original provenance.

Extend the `adopted` branch of `ObjectProvenance`
(`packages/protocol/src/activity.ts:303`) with optional `invocationId: string`.
It is present for action adoption, absent for host adoption and legacy rows.
Persist it on the source object itself in a nullable `adopted_invocation_id`
column, and in the equivalent memory provenance entry. Read it through both
adapters' `provenance` methods; never infer it from retained feed entries. The
existing source columns are in `packages/postgres/src/migrations.ts:114`; the
reader is in `packages/postgres/src/index.ts:223`.

All source changes accepted by the action carry its invocation ID in the feed.
Two existing rules forbid this today and must change together:

```ts
// packages/protocol/src/activity.ts:256, today
/** Native changes only; independent source changes do not inherit an invocation ID. */
readonly invocationId?: string;

// packages/runtime/src/activity-store.ts:329, today — runs in both adapters before publish
else if (draft.invocationId !== undefined)
  throw new InvalidDraft('source changes do not inherit an invocation');
```

New rule: a source change carries `invocationId` exactly when an action's
transaction accepted it; independent host adoptions and refreshes still omit it.
`validateFeedDraft` allows the field on `adopted`, `updated`, `deleted` and
`restored` drafts that name a source, and `sourceChangeDraft`
(`activity-store.ts:604`) copies it from an optional attribution field. The
transactional acceptance input requires that field; host attribution omits it.
Preserve the existing actor/triggered-by distinction for adoption versus later
source updates. Use the acceptance classifier's actual kind; re-adoption is not
always a new `adopted` event. No change means no source change entry. Emit all
business changes before `invocation-succeeded` in the same atomic feed batch.

## How adoption commits with the action

Adoption commits or rolls back with the action through commit-time acceptance.
`adopt` fetches and stages the observation in memory; the executor accepts all
staged adoptions on the transaction's connection as the last step before saving
the receipt. No record lock is held while the handler runs, so the handler's
later external calls and reads of the same record cannot block host ingestion or
deadlock on that record.

The helpers below describe the new overlay, not existing APIs. Its per-identity
critical section does no source I/O; the invocation can still fetch different
records concurrently.

```ts
adopt: async (sourceRecordId) => {
  const key = overlayKey(scope, sourceRecordId); // full StorageScope + source ID
  const observation = await fetchAndMap(sourceRecordId); // one bounded fetch
  const entry = await overlay.withIdentity(key, async () => {
    const staged = overlay.find(key);
    const existing = await store.resolve(scope, sourceRecordId); // DB lookup, no source I/O
    if (staged && existing && existing.objectId !== staged.objectId)
      throw new AdoptionConflict();
    // mergeOrdered keeps the first ID and orders incoming/committed/staged
    // observations with compareObservation. It never replaces by arrival order.
    return overlay.mergeOrdered(key, {
      scope,
      sourceRecordId,
      objectId: staged?.objectId ?? existing?.objectId ?? randomUUID(),
      isNew: staged?.isNew ?? !existing,
      existing,
      observation,
    });
  });
  await authorizeAsCaller(entry); // includes current account and dependencies
  return { id: entry.objectId };
};
```

Fetch results are private until validated. An entry being authorized is not
available to another operation as authorized evidence: every read evaluates its
own policy. Any failed adoption aborts the whole invocation even if caught.
Merging a committed or staged tombstone does not resurrect it with an older
present response; the winning state must be present and readable to return an
ID.

```mermaid
sequenceDiagram
  participant H as Handler
  participant P as Platform
  participant X as Executor
  participant T as Native transaction
  H->>P: create or recover ad group
  P-->>H: tt_123
  H->>P: poll until readable (integration code)
  H->>X: adopt('tt_123')
  X->>P: fetch through source binding (no record locks held)
  X-->>H: pending ID (overlay)
  H->>X: reads, native creates using the ID
  H-->>X: output
  X->>X: refresh and recheck references, validate, seal overlay
  X->>T: accept each staged adoption (record locks, DB work only)
  X->>T: save receipt, stage feed (incl. adopted entries)
  X->>T: COMMIT
```

- No record lock is held during handler I/O. The lock order is always the graph
  lock, then record locks. Host ingestion never takes the graph lock, so there
  is no cycle.
- On a declared failure or any abort, staged adoptions are discarded. Nothing
  reached storage.
- **Identity race:** host ingestion may adopt the same record between `adopt`
  and commit. At commit the store finds a member with a different ID. The
  executor aborts with retryable `ActionError('unavailable')`, and nothing
  commits. A retry with the same key reruns the handler. The journal recovers
  the external record, and `adopt` now returns the committed ID. The overlay
  cannot rewrite the pending ID because native records and output may already
  use it.

### Ordering at commit

The staged observation keeps the token from its fetch. At acceptance the store
compares it with whatever is committed now:

| Committed observation at commit time                                 | Result                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| None, or older than the staged one                                   | Accept the staged observation (`changed` / `unchanged` / `replay`) |
| Newer, but the **same view** (identical `state`, `raw`, `values`)    | Keep the committed one; report `unchanged`; no feed entry          |
| Newer with different values, a deletion, or a policy-relevant change | `AdoptionConflict` → whole action rolls back with `unavailable`    |
| Conflicting ordering evidence (`OrderingConflict`)                   | `AdoptionConflict` → whole action rolls back with `unavailable`    |

The same-view row is the one deliberate relaxation. Without it, re-adopting an
existing member that consumers read with `refresh` or a short `maxAgeMs` would
abort whenever any read landed during the handler's platform calls, and each
retry would re-run those calls through the journal: a retry storm on busy
records. A newer observation with identical content is the view the action
validated, so committing it is safe.

```ts
// inside transaction.accept, after compareObservation(previous.observation, staged) === 'superseded'
const sameView = (o: Observation) =>
  canonicalJson({ state: o.state, raw: o.raw, values: o.values });
if (sameView(previous.observation) !== sameView(staged))
  throw new AdoptionConflict();
return { object: previous, acceptance: 'unchanged' }; // committed winner, no change entry
```

There is never a successful `superseded` result on this transactional path, and
a newer deletion or policy change can never produce a successful receipt
referencing the old view. Host adoption and ordinary refresh keep their existing
supersession behavior. The executor never automatically reruns a handler; the
caller retries with the same key and integration journal.

## Storage contract

`NativeTransaction` (`packages/relate/src/storage.ts:202`) gains an optional
method. `NativeStore` advertises support synchronously, so runtime construction
does not need to open a transaction to discover it.

```ts
// Additions to packages/relate/src/storage.ts.
export interface NativeStore {
  readonly capabilities?: { readonly actionAdoption?: true };
}

export interface NativeTransaction {
  // …existing scan, savepoint, load, insert, claim, findInvocation, saveInvocation, appendFeed

  /**
   * Accept and adopt a source observation as part of this transaction.
   * Postgres uses the transaction's connection and record locks; memory uses
   * prepared writes and commit-time generation validation as specified below.
   * Called only by the executor after the handler and all reads finish; no
   * I/O follows except other DB work in this transaction.
   * With no member, `objectId` becomes the new Relate ID.
   * Reject mismatched IDs, or a newer committed observation that is not the
   * same view, with AdoptionConflict.
   * Results are conditional on outer transaction success; commit may conflict.
   * Return a classified change; the executor stages its feed draft exactly once.
   * This method must not independently publish a feed batch.
   */
  accept?(
    scope: StorageScope,
    input: {
      sourceRecordId: string;
      objectId: string;
      adopt: true;
      observation: Observation;
      attribution: AcceptAttribution & { readonly invocationId: string };
    },
  ): Promise<{
    object: StoredObject;
    acceptance: Exclude<Acceptance, 'superseded'>;
    change?: AcceptedChange;
  }>;
}

// packages/runtime/src/storage.ts, alongside NativeConflict (line 203).
export class AdoptionConflict extends Error {}
```

Today `ObservationStore.accept` rejects a supplied `objectId` when there is no
member (`packages/runtime/src/memory.ts:169`). The transactional variant defines
the preassigned-ID case explicitly. Each input scope must match the
transaction's graph ID and definition revision, and only present observations
may be adopted. Duplicate acceptance of one scoped identity in the same
transaction is invalid; the executor submits each sealed overlay entry once.

Runtime startup rejects a graph whose actions declare `adopts` unless
`store.native?.capabilities?.actionAdoption === true`. Source-only graphs and
actions with no adoption declarations do not require this capability. Every
transaction from an advertising adapter must expose `accept`. The executor
checks the actual method before running an adopting handler, as it checks
`appendFeed` today (`execute.ts:265`). An inconsistent advertisement fails
before any external effect. Both `createRuntime` and `startRuntime` use this
check in shared composition.

The guarded transaction in `packages/runtime/src/actions/deadline.ts:31` must
forward `accept` through the same pre/post-operation checks as `insert`.
Timeout, savepoint rollback and transaction closure revoke all staging handles;
late continuations cannot mutate the overlay or store.

**Memory store.** Observations and native records are separate maps today
(`packages/runtime/src/memory.ts:63`). Acceptance uses optimistic validation:

1. `accept` reads the committed identity and observation without yielding,
   validates the conflict rules, classifies the change, and prepares a private
   write. It captures an internal per-identity mutation generation, including
   absence. Every committed host acceptance/refresh advances that generation
   when it changes retained state, including observation metadata.
2. Return the prepared result to the executor for feed staging. Do not mutate
   shared source maps, provenance, history or feed. Savepoints restore both the
   prepared writes and their validation set.
3. After the transaction callback returns, run one synchronous commit step:
   verify every captured generation still matches; prepare and validate all
   source/native/provenance/history changes and the complete feed batch; then
   publish them together with no intervening await or fallible preparation.
4. Any generation mismatch throws `AdoptionConflict`; any preparation failure
   rolls back all prepared changes. Never recompute a different acceptance and
   publish the executor's old feed draft. A conflict on the second identity
   cannot leave the first adopted.

Thus an intervening host write can reject the transaction even after `accept`
resolved. The caller receives success only after outer commit. Shared ordering
and change-classification helpers keep memory and Postgres behavior aligned;
memory may conservatively abort when Postgres would have blocked a host writer.

**Postgres.** `accept` runs the existing acceptance SQL
(`packages/postgres/src/index.ts:276-…`) on the transaction's client, without
its own BEGIN/COMMIT or `publishFeed`. It holds record locks until outer commit,
checks identity and supersession before writes, and returns the classified
change. The executor stages its draft with native changes and the receipt event;
the adapter publishes the batch only as final work before COMMIT. A savepoint
can clean up a statement failure, but an adoption conflict still aborts the
whole action. An unconfirmed outer COMMIT retains the existing `uncertain`
outcome, rather than being mislabeled as a known conflict or rollback.

## Runtime changes

The existing executor drains registered operations and rolls back the handler
savepoint for a declared failure (`execute.ts:548-556`). Extend that boundary to
the overlay. The following finalization sketch uses new overlay helpers; keep
the existing error-detail parsing, deadline checks and receipt construction.

```ts
// packages/runtime/src/actions/execute.ts, finalization order (sketch)
await runHandlerBoundary(); // drain operations; rollback savepoint on fail()
if (domain) {
  const rolledBackIds = overlay.newMemberIds(); // fully scoped IDs
  overlay.discard(); // before any post-rollback authorization
  retainedReads = removeRolledBackReads(reads, created, rolledBackIds);
  await checkReferences(action.input, input);
  await checkReferences(action.errors[domain.code], domain.details);
  invocation = buildFailedInvocation(retainedReads);
  await authorizeReceipt(invocation); // committed view, no pending observations
} else {
  await checkReferences(action.input, input);
  await validateCreated();
  await checkReferences(action.output, output);
  await validatePendingAdoptions(); // present + readable, account/evidence checks
  checkCapturedValidation(); // local version/expiry checks; no source I/O
  const entries = overlay.seal(); // no further reads/source I/O after this point
  for (const entry of entriesInScopeOrder(entries)) {
    const accepted = await transaction.accept(entry.scope, entry.acceptInput);
    stageSourceChange(entry, accepted.change); // none on unchanged business state
  }
  invocation = buildSucceededInvocation(reads);
}
await transaction.saveInvocation(invocation);
await appendBusinessChangesThenInvocationEvent(); // one staged batch
// Adapter validates and commits; only then does invoke() return its receipt.
```

- `resolveEvidence` (`packages/runtime/src/runtime.ts:180`) checks the
  invocation overlay before the source store when called with an action context,
  for both source keys and canonical IDs. `source.read` also loads from that
  overlay before its direct store lookup (`resolution/source.ts:217`). Query
  candidate snapshots cannot bypass newer staged observations.
- The adopt fetch and authorization reuse `createSourceOperations().adopt` logic
  (`resolution/source.ts:407`), split so fetch-and-map can run without
  accepting. `host.adopt()` keeps its current self-committing path.
- Pending reads refresh into the overlay. Reads of identities never staged by
  this invocation keep their existing independently retained refresh behavior.
- Every validation records the overlay observations and policy dependency
  evidence it used. At the end, perform a local check that those observations
  are still the sealed versions and that the evidence has not expired. A later
  refresh that changed an earlier validation's view causes `unavailable` before
  acceptance; never keep an authorization decision for a replaced observation.
  This final check does no source I/O. Provider-account verification happens
  during the preceding reads and validation, not under acceptance locks. These
  checks also cover adoptions not returned or referenced by a native record.

### Declared failures and receipt dependencies

`adopt → get → fail('rejected', {})` must save a failed receipt that can be
looked up and replayed without adopting the discarded member. Extend the native
creation filtering at `packages/runtime/src/actions/execute.ts:598`:

- Revoke staging before rollback cleanup. Capture the set of new pending IDs,
  discard all pending observations, and remove reads of those new IDs from the
  failed receipt's dependencies, just as for rolled-back native creations.
- Keep reads of members that existed before this invocation, plus surviving
  input and source dependencies. Reauthorize them against committed data, not a
  discarded staged update. A dependency that is no longer readable rejects the
  invocation instead of saving an unauthorized failed receipt.
- Reference-valued failure details must resolve after rollback. A new pending ID
  in those details is invalid for the failed receipt and rejects with
  `not-found`; it is never made durable just to allow saving the error. A scalar
  detail may be derived from an authorized read of a rolled-back object, as for
  native creation today; it does not retain that nonexistent object as a replay
  dependency.
- Host adoption racing with rollback does not convert this invocation's
  discarded ID into a durable dependency. A later retry uses whatever identity
  was actually committed by the host.

## Failure cases

| Case                                                                 | Result                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Action succeeds                                                      | Membership, observation, native records, provenance, receipt and classified source/native feed changes commit atomically. |
| Handler throws, times out, returns invalid output                    | Transactional work rolls back; no receipt; staged adoptions discarded. Independent refreshes of unstaged members remain.  |
| Handler calls `fail(code)`                                           | Failed receipt saved after overlay cleanup and dependency reauthorization; references to new pending IDs reject.          |
| Record was already a member                                          | Membership and provenance are untouched by any rollback; on success only a newer observation is accepted.                 |
| Fetched record fails property mapping                                | `adopt` aborts with `invalid`; nothing is staged.                                                                         |
| Host adopts the same record during the action                        | Commit aborts with retryable `unavailable`; retry converges on the committed ID.                                          |
| A newer identical observation is committed before acceptance         | Same view: the committed observation wins, `unchanged`, no source feed entry; the action succeeds.                        |
| A newer different observation supersedes the staged one              | Abort with `unavailable`, including newer deletion or policy changes; no successful receipt based on the old view.        |
| Host changes a memory acceptance's captured generation before commit | Abort with `unavailable`; no partial source/native writes or stale feed classification.                                   |
| Outer COMMIT acknowledgement is lost                                 | Existing `uncertain` outcome; recover the receipt with the same key, do not assume rollback.                              |
| External create succeeded, local work failed                         | External record remains. Relate never deletes it or claims cross-system rollback.                                         |
| External create result unknown (lost response)                       | Integration journal recovers by documented platform reads, or reports an unresolved outcome. Never a blind second create. |
| Record not yet fetchable when `adopt` runs                           | Connector error → `unavailable`, no receipt, retry. Integration polling before `adopt` is the normal way to avoid this.   |

## External writes and recovery

The SDK guarantees the local side only:

- `idempotencyId` names the logical operation across retries. It does not
  deduplicate anything in the platform.
- The journal (or the platform's own idempotency support) is integration code.
  It persists outside the action transaction, because a rollback must not erase
  the record of an external write.
- A journal cannot close the gap between "platform created it" and "journal
  saved the response". Recovery must look the record up with documented platform
  reads (for example by a name that embeds the idempotency ID). When that fails,
  report the outcome as unresolved.
- Visibility polling after a create is integration code for the same reason:
  only the integration knows which platform read confirms the record.

Docs (`apps/docs/content/runtime/actions.md`, "External writes and idempotency
IDs") gain a create-then-adopt section showing journal, polling and `adopt`
together, including the graph-lock cost of waiting inside a handler.

## Compatibility with future sync

Adoption and future sync must share identity and acceptance rules:

- A later observation updates the same object. Adopting `tt_123` at budget `500`
  and later observing it at `600` keeps the Relate ID and shows `600`.
- Adoption creates no local override of source values.
- A future "ingest already-fetched records" API should reuse the same fetch-free
  acceptance step that commit-time acceptance introduces. Automatic discovery
  and sync are out of scope here.

## Deferred: typed absence and `waitMs`

An earlier draft gave `adopt` a `waitMs` option that retried a new connector
error, `SourceNotFound`, meaning "authenticated absence without deletion
evidence". It was removed from v1 for the reasons in
[Records that are not yet fetchable](#records-that-are-not-yet-fetchable). The
shape is recorded here so it can be revived without redesign:

```ts
// packages/relate/src/connectors.ts — deferred
type SourceData =
  | { state: 'present'; record: Record<string, Json>; version?: SourceVersion }
  | { state: 'deleted'; version?: SourceVersion }
  | { state: 'absent' }; // not visible yet; not deletion evidence. Rejected by observation().

// handler context — deferred
adopt(sourceRecordId: string, options?: { readonly waitMs?: number }): Promise<{ id }>;
```

If revived, prefer the `state: 'absent'` result over a thrown error class: it
travels the same account-evidence path as `present` and `deleted` through
`boundedFetch` (`packages/runtime/src/observations/fetch.ts:29`), so no
validation branch for error objects is needed. Open points that must be settled
first:

- What an ordinary read of an existing member does on `absent`: stale fallback
  with a warning (consistent with "not deletion evidence") or `not-found`.
- Which error code an exhausted wait returns. `not-found` collides with "missing
  input reference" and reads as terminal; `unavailable` is retryable.
- A connector-by-connector rule for telling absence from denial on a 404.

**Trigger to revisit:** the benchmark's `launchAdGroup` task shows retries
caused by connector 404s after the integration already confirmed visibility.

## Deferred: integration helpers

v1 ships no SDK helper for external writes. Integrations write their own journal
and visibility polling, as in [The API](#the-api) and
[External writes and recovery](#external-writes-and-recovery). Both are needed
by every create-then-adopt action, so the need is recorded here:

- **Journal helper**, such as
  `journal.once(idempotencyId, create, { recover })`. Without one, a retry after
  a lost response or timeout must not call the platform's create again; each
  integration has to persist the operation outside the action transaction and
  recover by documented platform reads.
- **Visibility-poll helper**, such as `waitFor(read, { timeoutMs })`. Platforms
  often return an ID before their read API serves the record, so each
  integration writes a short poll loop and a declared `notVisible` failure. The
  poll runs under the graph lock, so a helper would also enforce short waits.

**Trigger to revisit:** the benchmark's create-type tasks repeat the same
journal or polling code across integrations, or show duplicate external effects
or lock-time cost a shared helper would prevent. Decide both helpers together.

## Files

Implementation ownership:

| File                                                                                            | Change   | Why                                                                                                        |
| ----------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/relate/src/index.ts`                                                                  | modified | Export `SourceMembership` next to `NativeMembership`                                                       |
| `packages/relate/src/actions.ts`                                                                | modified | `adopts` on definitions, both capability lists optional, `'adopts'` in `actionKeys`; `adopt()` on context  |
| `packages/relate/src/compiler.ts`, `src/model.ts`                                               | modified | Validate and compile `adopts`; manifest field                                                              |
| `packages/relate/src/storage.ts`                                                                | modified | Synchronous capability advertisement; transactional acceptance input/result contracts                      |
| `packages/node/src/runtime.ts`                                                                  | modified | Bind declared `adopt`; constrain `host.adopt` with `SourceMembership`; share startup capability checks     |
| `packages/runtime/src/actions/execute.ts`                                                       | modified | Pending overlay, commit-time acceptance, feed staging, conflict mapping                                    |
| `packages/runtime/src/actions/adoption.ts`                                                      | new      | Invocation-owned overlay, scoped identity serialization, ordered staging                                   |
| `packages/runtime/src/actions/deadline.ts`                                                      | modified | Forward guarded `accept`; revoke late staging                                                              |
| `packages/runtime/src/storage.ts`                                                               | modified | Export `AdoptionConflict` alongside existing adapter errors                                                |
| `packages/runtime/src/resolution/source.ts`, `src/resolution/refresh.ts`                        | modified | Split fetch/map from retention; refresh pending observations locally                                       |
| `packages/runtime/src/runtime.ts`, `src/queries/query.ts`                                       | modified | Overlay-aware reads, policy resolution and sorted-merge source scans                                       |
| `packages/runtime/src/observations/ordering.ts`                                                 | modified | Shared same-view comparison used by both adapters' transactional acceptance                                |
| `packages/runtime/src/native-memory.ts`, `src/memory.ts`                                        | modified | Prepare acceptance, validate generations, publish atomically; retain invocation provenance                 |
| `packages/postgres/src/native.ts`, `src/index.ts`, `src/migrations.ts`                          | modified | Transactional acceptance without separate feed publication; provenance column and reader                   |
| `packages/runtime/src/activity-store.ts`, `src/activity/feed.ts`                                | modified | Allow `invocationId` on source-change drafts; copy it in `sourceChangeDraft`; order changes before receipt |
| `packages/runtime/src/discovery/index.ts`, `packages/protocol/src/discovery.ts`                 | modified | `adopts` in `ActionDescription`                                                                            |
| `packages/http`, `packages/client`, `packages/mcp` (description passthrough only)               | modified | Carry `adopts` wherever descriptions are re-validated or re-serialized                                     |
| `packages/protocol/src/activity.ts`                                                             | modified | Optional invocation ID on adopted-object provenance; corrected `Change.invocationId` comment               |
| `tests/support/adoption-action-contract.ts`                                                     | new      | Shared memory/Postgres acceptance suite with a test-owned fake platform and journal                        |
| `packages/relate/README.md`, `packages/runtime/README.md`, `packages/runtime/STORE_CONTRACT.md` | modified | Public authoring, runtime and adapter contracts                                                            |
| `apps/docs/content/runtime/actions.md`                                                          | modified | Create, poll, adopt; read/query behavior; failure receipts; recovery limits; graph-lock cost of waiting    |

## Done when

Tested through the public application path on memory and Postgres. Package tests
use a test-owned fake platform and journal, never benchmark code. The fake
journal is the contract under test in item 13; it is not an SDK promise.

1. Declaration: undeclared targets, native targets in `adopts`, source targets
   in `creates`, omitted `creates`/`adopts`, and branded ID types are rejected
   or checked. `host.adopt` and `adopts` accept the same `SourceMembership`
   shape.
2. Create externally → adopt → read and reference within the handler → typed ID
   readable after commit when source state and authorization remain unchanged.
3. Rollback on throw, `fail`, invalid output, timeout and a caught adoption
   error, with no leaked membership or `adopted` feed entry.
4. Repeat and concurrent adoption preserve the first pending ID. Host adoption
   between two calls produces a conflict, never ID substitution. Same provider
   key across types/accounts stays isolated; reverse fetch completion preserves
   the newer observation and rejects conflicting ordering evidence.
5. Principal and provider-account isolation; unreadable records fail as
   `not-found` without leaking IDs or data. A record that fails mapping fails as
   `invalid`.
6. Adopt → await beyond `maxAgeMs` or policy evidence age → read/output
   validation refreshes into the overlay. Explicit refresh works. Expired
   evidence, denial and deletion never authorize stale values; rollback retains
   none of those staged observations.
7. Query-after-adopt includes pending members; re-adoption can change predicate
   matches. Test ordering, deduplication, scan bounds, page boundaries and
   invocation-scoped cursors, including a pending ID that sorts before, inside
   and after a committed page, adoption between pages and a restarted query.
   Committed scan snapshots cannot override staged values.
8. Adopt → get → fail saves a failed receipt that survives lookup, replay and
   Postgres restart. Reads of new pending IDs are pruned; dependencies on
   existing members are retained and reauthorized. New pending IDs in reference
   error details reject without a saved receipt. Test host adoption racing with
   rollback and a native creation that referenced the discarded adoption.
9. A newer committed observation with different values, a deletion or a policy
   change causes acceptance conflict and full rollback. A newer committed
   observation with identical content succeeds as `unchanged` with no source
   feed entry. Retry with the same key converges without rerunning a journaled
   external effect. No successful `superseded` acceptance is returned by the
   transaction.
10. Memory: inject host writes after `accept` resolves but before commit; reject
    generation mismatches with no source/native/provenance/feed mutation. Also
    fail the second of multiple adoptions and feed preparation after acceptance;
    verify that all earlier prepared writes roll back. Postgres: verify host
    contention, outer rollback and exactly one atomic feed publication.
11. Missing capability advertisement rejects startup for adopting graphs on both
    constructors; inconsistent transaction methods reject before handler
    execution. The guarded transaction forwards `accept` and revokes it after
    timeout/closure. Non-adopting graphs keep working with existing adapters.
12. Action adoption persists invocation provenance independently of activity
    retention, including after restart. Host/legacy provenance omits it;
    re-adoption preserves it. Feed kinds reflect actual accepted transitions,
    include the invocation ID, pass `validateFeedDraft` in both adapters and
    precede the invocation event; no-op acceptance emits no source change.
    Staged reads report unconfirmed evidence.
13. Lost create response, delayed visibility handled by integration polling, and
    retry after restart produce no duplicate business effects or false success
    under the test integration's journal/recovery contract; unresolved external
    outcomes remain unresolved. A connector 404 at `adopt` time surfaces as
    `unavailable` with no receipt. A lost local COMMIT acknowledgement returns
    `uncertain` and is recovered by receipt replay rather than assumed rollback.
14. Discovery over HTTP, client and MCP shows `adopts` for an adopting action
    and an empty list otherwise.
15. `pnpm check` (or `pnpm test:unit` without a test database, reported as
    such), `pnpm check:boundaries` and `pnpm test:packaging`.

## Appendix: research basis (reviewed 2026-10-28)

These are precedents for the design, not claims that Relate copies their
internals.

- [Palantir action webhooks](https://www.palantir.com/docs/foundry/action-types/webhooks):
  external writeback runs before Ontology edits and its response feeds later
  rules; external success followed by local failure is allowed. This matches
  create-then-adopt.
- [Palantir action consistency](https://www.palantir.com/docs/foundry/action-types/consistency-guarantees):
  local edits commit atomically and external calls are excluded; actions with
  external calls are not retried by default. This matches the local boundary and
  separate recovery.
- [Palantir Ontology edits](https://www.palantir.com/docs/foundry/functions/edits-overview)
  declare affected types, as `adopts` does.
- [Palantir edits vs datasource updates](https://www.palantir.com/docs/foundry/object-edits/how-edits-applied):
  Relate keeps source observations without a user-edit override layer.
- [Crossplane import](https://docs.crossplane.io/latest/guides/import-existing-resources/)
  and its
  [creation annotations](https://docs.crossplane.io/latest/managed-resources/managed-resources/#creation-annotations):
  local and external identity are separate, and a lost external ID never
  justifies a blind create.
- [Terraform import](https://developer.hashicorp.com/terraform/language/import):
  provider identity is scoped by account and region, like Relate's source
  identity.
