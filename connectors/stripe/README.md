# @relate/connector-stripe

Read Stripe billing records through Relate's authorized object API. This package
implements read-only API v1 lookups for `customers`, `invoices`,
`subscriptions`, `products`, `prices`, `payment_intents`, and `charges`. It uses
Node's built-in fetch; no Stripe SDK or runtime dependency is required.

```ts
import { stripe } from '@relate/connector-stripe';
import { connect, defineSource } from 'relate';
import { z } from 'zod';

const customers = defineSource({
  id: 'stripe.customers',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
});
const billing = stripe({
  apiKey: () => process.env.STRIPE_SECRET_KEY!,
  apiVersion: '2025-06-30.basil', // Pin the version your schema targets.
  mode: 'test',
});
const binding = connect(customers, {
  connectionId: 'billing',
  providerAccountId: 'acct_yourAccount:test',
  connector: billing.resource('customers', { fields: ['name', 'email'] }),
});
// Return { graphId, connections: [binding] } from defineApp.setup.
// Define objects using source(customers) and from(customers.fields.name).
// Adopt a known cus_... ID through app.host.adopt, then read as an actor.
```

IDs are opaque provider keys: custom product IDs such as `gold-plan`, legacy
plan IDs read through `prices`, and `py_` charge IDs are supported. The
connector encodes each ID as one URL path segment and verifies the returned ID
and object type; empty IDs, dot segments, path separators, and control
characters are rejected locally.

`id` is always included; the source's `idField` must be `id`. `fields` selects
literal top-level fields to retain in Relate. Stripe still sends its normal
response; unselected fields are discarded by the connector before observation
storage. Selected objects/arrays are kept in full, including any personal data
inside them. A selected field Stripe does not return is left out of the record
(customer `subscriptions`, `sources` and `tax_ids`, for example, only appear
when expanded, which this connector does not do); the source schema decides
whether that is acceptable. Explicit nulls remain null. Nested JSON is
preserved, while nonfinite numbers and unsafe integer values are rejected.
Define the source schema against your pinned version, including nullable fields.
Money stays in Stripe's integer minor units and timestamps stay in seconds.
Nested list fields (such as invoice lines) may be partial: this connector does
not fetch their remaining pages or expand references.

## Verified provider scope

`providerAccountId` is `<account ID>:<mode>`, for example `acct_123:test` or
`acct_123:live`. A Stripe account alone does not identify a record namespace.
The account comes from `GET /v1/account`; mode is checked against the secret or
restricted key prefix, and present records must have the matching `livemode`.
Only `sk_test_`, `rk_test_`, `sk_live_`, and `rk_live_` keys are supported.
OAuth, organization keys and API v2 contexts are outside this slice.

The key must be allowed to retrieve the current account (`GET /v1/account`) as
well as the selected resources. A restricted key with only `customers:read`
cannot prove which account it belongs to, so every read is denied.

`apiKey` may be a string or an async callback receiving `{ signal }`. Each
operation resolves it once and reuses the immutable result for account
verification and the resource request. A callback permits rotation without
rebuilding the binding. Never change a key to represent a different source under
an existing binding.

`identify` always calls `GET /v1/account`. A Stripe key belongs to one account
for its lifetime, so `fetch` remembers the scope verified for the current key
and sends only the resource request; a new key is verified again. A 401/403 on
any request forgets the remembered scope. Relate may serve cached observations
according to its freshness policy without calling the connector. Set policy
evidence freshness and read `maxAgeMs` according to your application's
requirements.

For Stripe Connect, set `account: 'acct_connected'`. Both requests carry the
`Stripe-Account` header, and the returned account must match it. Bind using
`providerAccountId: 'acct_connected:test'`. A configured account is a routing
hint, not identity evidence. When a key is first verified, account verification
and retrieval run concurrently using the same key and account header. Both must
succeed before data is returned; explicit denial takes precedence over an outage
in the other request. Revoked credentials produce denial on the next request,
never stale authorization.

## Errors and deadlines

- HTTP 401/403, invalid account identity, Connect mismatches, and wrong record
  mode throw `SourceAccessDenied`.
- A missing, malformed or wrong-mode key is local misconfiguration, not provider
  denial. It throws `StripeSourceError` before any request is sent, so Relate
  reports the source unavailable instead of treating records as inaccessible.
- A matching resource with `deleted: true` returns `state: 'deleted'`. Stripe
  documents this for deleted customers. These tombstones normally omit
  `livemode`, so their mode comes from the verified account and immutable
  secret/restricted key context. A tombstone that supplies contradictory mode
  evidence is denied. A 404 (including `resource_missing`) is not affirmative
  deletion evidence: wrong IDs, mode or access context can also cause
  missing-resource errors.
- Other HTTP failures throw `StripeSourceError`, with an optional numeric
  `status`. Transport failures, invalid JSON, wrong object/ID, malformed
  selected fields and the connector deadline also throw it. Caller cancellation
  rejects with the caller's abort reason. Error messages never copy credentials,
  provider response bodies, or upstream exception messages. These failures
  follow Relate's existing unavailable/stale-fallback policy; they do not delete
  data.
- No source `version` is claimed. Stripe's creation time and request IDs are not
  per-record revision ordering.

Connector `timeoutMs` defaults to 10,000 and covers credentials plus both
concurrent requests. Relate also applies its own per-source-call timeout, which
defaults to 3,000 ms (read requests can set `timeoutMs`). The earlier deadline
wins: configuring a 10-second connector deadline does not extend the runtime's
3-second limit. Identity checks and record fetches have separate runtime
budgets, not a single 3-second budget for the entire read. Caller cancellation
propagates to fetch. Operation timers and caller listeners are released on
completion. Callbacks/transports should honor the signal; a noncooperative
callback may continue after the caller is rejected, but cannot start a request
after cancellation. `maxResponseBytes` defaults to 2 MiB per response and bounds
streamed response consumption. Redirects are rejected. There are no automatic
retries, background jobs, or owned connections to close. A trusted `fetch`
override supports deterministic testing; production requests use the fixed
`https://api.stripe.com/v1/` endpoint.

Enumeration, search, webhooks, provider writes, and payment actions are not
implemented. Cancelled subscriptions and archived products remain present
records, with their provider status fields intact.

## Contract lessons

SQLite selects a table; Stripe selects an API resource. Both produce a
`SourceConnector` from a connection factory, keeping resource selection,
credentials, transport, and lifecycle out of the runtime. Stripe confirms that
provider identity must describe the full record namespace, that deletion needs
positive evidence, and that version evidence is optional. No new required
connector method or generic HTTP abstraction is needed for these reads. Future
listing and event delivery should establish their own tested capability
contracts rather than being implied by `fetch`.

References: [authentication](https://docs.stripe.com/api/authentication),
[Connect requests](https://docs.stripe.com/api/connected-accounts),
[current-account implementation](https://github.com/stripe/stripe-node/blob/master/src/resources/Accounts.ts),
[deleted customers](https://docs.stripe.com/api/customers/retrieve),
[version pinning](https://docs.stripe.com/api/versioning).

Tests use deterministic HTTP response fixtures and the real Relate application
path. They do not claim validation against a live Stripe account.
