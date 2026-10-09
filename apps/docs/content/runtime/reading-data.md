# Querying & Traversal

Once your graph is defined, you read it through the `@relate/node` embedded
runtime.

Every read is **scoped to an authenticated principal**, **typed** by your graph,
and returns **compact evidence** by default. Request full evidence to inspect
where each field came from and how fresh it is.

---

## 1. Creating the Runtime

`createRuntime` compiles your graph and binds a connector to each source:

```ts
// runtime.ts
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { addAccountReview } from './actions/add-account-review.server.js';
import { graph } from './graph.js';
import { billingInvoices, crmCustomers } from './model.js';
import { billingConnector, crmConnector } from './connectors.js';

export const relate = createRuntime({
  graph,
  // Every action registered in the graph needs an implementation.
  actionImplementations: [addAccountReview],
  connections: [
    connect(crmCustomers, {
      providerAccountId: 'crm-account',
      connectionId: 'crm-primary',
      connector: crmConnector,
    }),
    connect(billingInvoices, {
      providerAccountId: 'billing-account',
      connectionId: 'billing-primary',
      connector: billingConnector,
    }),
  ],
});
```

A connector authenticates with its provider and fetches one record at a time:

```ts
// connectors.ts (excerpt)
export const crmConnector = {
  // Return the provider's stable account ID for the current credentials.
  identify: async () => 'crm-account',
  async fetch(sourceRecordId: string) {
    const record = await crm.customers.get(sourceRecordId); // your API client

    return record
      ? { providerAccountId: 'crm-account', state: 'present' as const, record }
      : { providerAccountId: 'crm-account', state: 'deleted' as const };
  },
};
```

Omitting `store` uses an in-memory store that is lost when the process exits.
For durable storage, see [Persistence](../deployment/postgres.md). If the graph
has no actions, leave out `actionImplementations`; see
[Actions, Mutations & Receipts](./actions.md) for how they are defined.

Call `await relate.close()` on shutdown to stop new operations and wait for
in-flight ones.

---

## 2. Adopting Source Records

Relate reads only records that are members of the graph. The host adopts a
source record by its source key, and Relate returns a generated, branded object
ID:

```ts
import { Customer, Invoice } from './model.js';
import { relate } from './runtime.js';

const customerId = await relate.host.adopt(Customer, 'crm_456');
await relate.host.adopt(Invoice, 'inv_1');
```

Object IDs are UUIDs, not source keys. Store them and pass them to reads; a
plain string such as `'crm_456'` is not accepted where an `ObjectId` is
expected. Adoption is a host operation and is not available to callers.

---

## 3. Scoping Calls to a Principal

Every call runs as a principal that the host has authenticated. `relate.as()`
takes the principal's ID, roles, and claims:

```ts
const { objects } = relate.as({
  id: 'user_123',
  roles: ['employee'],
  claims: { portfolio: 'emea' },
});
```

`objects` has typed operations for every object in the graph. Relate trusts the
roles and claims you pass; establishing them is the host's job.

---

## 4. Reading an Object by ID (`.get`)

```ts
const result = await objects.Customer.get(customerId, {
  select: ['name', 'status', 'revenue'],
});

if (result.status === 'not-found') {
  // The record does not exist, or the caller may not see it.
  console.log('Customer not found or not visible.');
} else {
  console.log(result.id, result.data.name);
  console.log(result.meta.fields?.revenue); // { status: 'forbidden' } without `finance`
}
```

`get` returns either `{ status: 'not-found' }` or
`{ status: 'ok', id, data, meta }`. It never returns `null` and never reveals
why a record is hidden.

### Selecting Properties (`select`)

`select` limits `data` to the named properties, and TypeScript narrows its type
to match. Selected properties are still optional: a field can be forbidden by a
field group or unavailable from its source. Check `meta.fields`, or use
`assertFields` when the code requires a value:

```ts
import { assertFields } from 'relate';

assertFields(result, ['name']); // throws unless `name` is present
console.log(result.data.name.toUpperCase());
```

Read options also include `evidence`, `maxAgeMs`, `refresh`, `stale`,
`requireComplete`, and `timeoutMs`; see
[Evidence and Freshness](#evidence-and-freshness).

---

## 5. Traversing Relationships (`.traverse`)

Relationships registered in `defineGraph({ relationships })` appear under
`.traverse`. The relationship below declares `forward: 'invoices'` and
`reverse: 'customer'`:

```ts
// model.ts (excerpt)
export const CustomerInvoices = defineRelationship({
  id: 'business.customer-invoices',
  forward: 'invoices',
  reverse: 'customer',
  via: Invoice.properties.customer,
});
```

A to-many traversal returns a lazy query result. Awaiting it gives one page:

```ts
const page = await objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
  limit: 50,
});

for (const invoice of page.data) console.log(invoice.id, invoice.data.status);

if (!page.meta.exhausted) {
  // Pass page.meta.continuationCursor as `cursor` to fetch the next page.
}
```

Iterating it with `for await` follows pages on demand:

```ts
for await (const invoice of objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
})) {
  console.log(invoice.id, invoice.data.status);
}
```

A to-one traversal returns the same result shape as `get`:

```ts
const invoiceId = page.data[0]!.id;
const owner = await objects.Invoice.traverse.customer(invoiceId, {
  select: ['name'],
});
```

Source-backed traversals include only adopted records. For each one, Relate:

1. Checks the caller's read access to the starting record.
2. Resolves the reference between the two objects.
3. Applies the target object's policy and field groups to each record.
4. Leaves out records the caller may not see, as if they did not exist.

### Many-to-many traversal

A registered
[`through` relationship](../authoring/graph.md#many-to-many-relationships)
exposes a to-many traversal in each direction:

```ts
const songs = await objects.Playlist.traverse.songs(playlistId, {
  select: ['title'],
  limit: 25,
});

for await (const playlist of objects.Song.traverse.playlists(songId, {
  select: ['name'],
})) {
  console.log(playlist.id, playlist.data.name);
}
```

Both calls return the same lazy page/async-iteration interface as other to-many
traversals. Selections and compact/full evidence describe the destination
object. Duplicate memberships yield one destination, including across pages.
Results use destination object-ID order; playlist position and repeated entries
remain available through the junction object.

Relate checks access to the starting object, the junction record, both reference
fields, and the destination. A hidden junction or restricted reference cannot be
bypassed by selecting only the destination's title. A destination needs at least
one readable connecting membership. Provider denial does not fall back to a
retained link. Membership changes and deletions are observed according to the
read's freshness options; use `refresh: true` to request fresh source data.

Traversal covers existing graph records, including native endpoints and native
junctions. It does not discover or adopt external records. Each page makes one
pass over the junction records, scanning at most 100 per call, and returns the
smallest destinations it found. Cost grows with the number of junction records,
not with the number of destination objects. A junction with more than 100
records takes several calls per page, including empty pages with
`meta.exhausted: false`. Follow the continuation cursor or use `for await`; an
empty page alone does not mean the traversal is finished. This is a bounded scan
implementation, not an indexed database join.

Cursors preserve the junction scan position and pending destinations without
revealing hidden IDs. They expire after 15 minutes and are scoped to the graph
revision, source bindings, caller, starting object, relationship direction,
selection, read options, and page size. Switching between compact and full
evidence is allowed. Pagination is not a snapshot: concurrent membership changes
can affect later pages.

---

## Evidence and Freshness

Every successful read carries compact evidence by default. It includes the
selection's completeness, degradation flag and graph revision. Exceptional field
evidence and nonempty warnings are preserved; routine field evidence is omitted.
Request `evidence: 'full'` for all selected fields' provenance.

```ts
const detailed = await objects.Customer.get(customerId, {
  select: ['name'],
  evidence: 'full',
});

// Requesting full evidence types `meta.fields` as always present.
if (detailed.status === 'ok') console.log(detailed.meta.fields.name);
```

See [Read Responses & Evidence](../reference/read-responses.md) in **Reference**
for every response field, evidence status, warning, read option and pagination
rule, with compact and full examples.

Freshness is controlled by read options, not by the policy:

- `maxAgeMs` (default `60_000`): stored observations older than this are fetched
  from the source again.
- `refresh: true`: always fetch from the source.
- If a fetch fails, the last stored value is returned with `freshness: 'stale'`
  and the read is marked `degraded`. Pass `stale: 'omit'` to report stale fields
  as `unavailable` instead.
- `requireComplete: true` throws `ReadError('incomplete')` instead of returning
  a partial result, including when a selected field is forbidden.

A policy's `evidenceMaxAgeMs` limits only the age of the evidence used to decide
access; see
[Access Control](../authoring/access-control.md#4-evidence-age-evidencemaxagems).

The full result and evidence types are in
[`packages/protocol/src/index.ts`](../../../../packages/protocol/src/index.ts).
