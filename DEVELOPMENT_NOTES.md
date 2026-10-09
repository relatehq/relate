# Development change and migration notes

These are unreleased notes, not Changesets and not a request to bump versions.
All public packages remain at `0.0.0-dev.0`. Preserve breaking-change guidance
here while release tooling is disabled. When releases are explicitly activated,
review these entries and incorporate them into the first release notes and
migration guide.

## Graph queries and native enumeration

Add `objects.Type.query({ where?, select?, limit?, cursor?, ...readOptions })`
for consumers and native action implementations. No separate list operation is
needed: omitted filters enumerate. Equality filters use public property names
and canonical reference IDs. Queries cover existing graph membership, not
provider-wide discovery; direct source queries and sync are planned.

Custom native storage adapters must now implement `NativeStore.scan` and
`NativeTransaction.scan`, preserving scoped keyset order and read-your-writes.
Memory and Postgres implement both. No database schema migration or manifest
format change is required. Source-only observation stores remain valid.

`QueryResult` is now a portable protocol type, re-exported by runtime, node and
relate; the existing runtime import remains valid. Shared typed query options
and object records live in `relate`, avoiding a runtime dependency for action
contracts. Package versions remain `0.0.0-dev.0`.

## Portable constraints and declared business failures

Preserved from the former `clear-kids-care` changeset; the behavior is already
implemented. Affected packages: `relate`, `@relate/protocol`, `@relate/runtime`,
`@relate/postgres`, and `@relate/node`.

Support portable string lengths and numeric bounds on action inputs, native
properties and compiled discovery metadata. Applications can now reject empty or
oversized review notes consistently, including values constructed inside a
handler.

Add declared business failures through `errors` and `fail(code, details)`.
Native writes roll back while the failed receipt is saved for actor-bound lookup
and replay. An inactive customer can produce an explainable business outcome
instead of a generic internal error. Malformed requests and permission denials
remain sanitized rejections.

Breaking changes in this pre-1.0 API: compiled manifests use format 4 and
require recompilation and explicit installed-revision migration;
missing/unreadable action object references now reject with `not-found`; custom
native storage adapters must implement transaction savepoints. Receipt
lookup/replay retains its opaque `denied` response. Actions without declared
errors retain their success-only receipt type.

## Application-owned connector identity

SQLite now defaults to `sqlite({ path })`, with application-owned `connectionId`
and no account table. Optional `identity: { table, column }` retains provider
verification and requires the expected `providerAccountId` binding.

Custom stores must support `StorageScope.providerAccountId: string | null`: null
denotes application-owned identity and must never share aliases or observations
with verified accounts or unknown legacy provenance. Run the Postgres store's
`migrate()` for the new physical identity-mode constraint; old migration
checksums and quarantined legacy rows are preserved. Switching modes requires
adoption in the new scope; no automatic identity/data reassignment is performed.
Replacing a logical source in application mode requires a new `connectionId`.
This mode does not detect accidental file replacement.

## Numbered learning examples

Example folders now follow the order in `examples/README.md`: `01-hello-world`,
`02-customer-accounts`, `03-customer-workspace`, and `04-postgres-persistence`.
Existing `pnpm example:hello-world`, `pnpm example:customer-accounts`, and
`pnpm example:postgres` commands are unchanged. Update direct file paths or
imports into the old example folders. The new browser example runs with
`pnpm example:customer-workspace`.

## Stripe source connector

`@relate/connector-stripe` adds read-only Stripe API v1 resource lookups with
explicit field selection, pinned API versions, credential rotation, Connect
account verification, deadlines, and bounded responses. Its provider identity is
`<account ID>:<test|live>`; custom Stripe connectors migrating to this package
must rebind and adopt records in that scope instead of relabeling existing
observations. SQLite and other existing connectors keep their current identity
formats. No storage migration or new required connector method is introduced.

The shared connector documentation now explicitly allows provider namespaces in
identity. Stripe confirms that creation times/request IDs must not be presented
as versions, and that a missing-resource HTTP error is not deletion evidence.
See the connector README for supported resources and the current read-only
boundary; list/search/webhook/write capabilities are not implied.

## Compact evidence is the default

`get`, `query`, traversal, low-level runtime reads and action-handler reads now
return compact evidence by default. Existing code that inspects ordinary
per-field provenance must pass `evidence: 'full'`. Both modes include
`meta.evidence`; compact mode omits `meta.fields` and `meta.warnings` when
empty. Use `result.meta.fields?.name`, or narrow
`result.meta.evidence === 'full'` before accessing the full map.

No stored data migration is needed. Reissue collection queries after upgrading:
continuation tokens are not an upgrade compatibility contract. Exceptional field
evidence and nonempty warnings remain available in compact mode. Data,
authorization and action receipt dependency tracking are unchanged.
