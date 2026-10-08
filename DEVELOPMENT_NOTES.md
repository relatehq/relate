# Development change and migration notes

These are unreleased notes, not Changesets and not a request to bump versions.
All public packages remain at `0.0.0-dev.0`. Preserve breaking-change guidance
here while release tooling is disabled. When releases are explicitly activated,
review these entries and incorporate them into the first release notes and
migration guide.

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
