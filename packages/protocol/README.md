# @relate/protocol

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

Transport-neutral request, result, evidence and error shapes shared by every
Relate consumer surface. Private and unpublished.

## Responsibility

- Requests: `ReadRequest` (`select`, `maxAgeMs`, `refresh`, `stale`,
  `requireComplete`, `timeoutMs`) and `TraversalRequest` (`limit`, `cursor`).
- Results: `ObjectResult` and `ObjectRecord` (`ok` with the canonical `id`,
  partial `data` and `meta`, or `not-found`), `Page<T>` with `PageMeta`, and the
  engine-level `ReadResult`.
- Evidence: `FieldEvidence` for each selected field: availability, freshness,
  source identity, retention, ordering and refresh outcome.
- Errors and receipts: `ReadError` and `ActionError` with sanitized codes and no
  private detail, and `SucceededReceipt`.
- `Json`.

These are types plus two error classes. The package has no runtime, database,
provider or schema-library dependency and performs no validation itself.

## How it fits

- Dependencies: none.
- `relate` uses these shapes for `assertFields` and typed results.
  `@relate/runtime` produces them. `@relate/node` re-exports typed
  specializations of them.
- The planned `@relate/http`, `@relate/client` and `@relate/mcp` carry exactly
  these shapes over the wire, so embedded and remote consumers see the same
  results and evidence.

## Public API

```ts
import { ReadError } from '@relate/protocol';
import type { ObjectRecord, ObjectResult, Page } from '@relate/protocol';

function customerName(result: ObjectResult): string | undefined {
  if (result.status === 'not-found') return undefined;

  // Selection never guarantees presence: authorization or availability can
  // withhold a field. Evidence says why a value is what it is.
  const evidence = result.meta.fields.name;

  if (evidence?.status === 'forbidden') {
    // The caller's roles do not grant this field; retrying cannot change that.
  }

  if (evidence?.status === 'unavailable') {
    // Readable in principle, but no value could be supplied right now.
  }

  if (evidence?.status === 'available' && evidence.freshness === 'stale') {
    // Served from retained observations; decide whether that is acceptable.
  }

  const name = result.data.name;

  return typeof name === 'string' ? name : undefined;
}

function nextCursor(page: Page<ObjectRecord>): string | undefined {
  // Follow exhaustion, not record count: an empty page can still continue.
  return page.meta.exhausted ? undefined : page.meta.continuationCursor;
}

function isIncomplete(error: unknown): boolean {
  return error instanceof ReadError && error.code === 'incomplete';
}
```

## Status

Results, pages, evidence and errors are implemented and used by the engine. HTTP
and MCP encodings are not implemented. The types alone do not validate incoming
JSON; the runtime validates what it produces and accepts.

## Further reading

- [CONTRACT.md](./CONTRACT.md): result and evidence semantics, durability versus
  retention, and the page contract.
- [`assertFields`](../relate/CONTRACT.md#require-values-after-a-read): the
  consumer-side presence check and its narrowing rules.
- [Pagination](../runtime/CONTRACT.md#pagination): the implemented helper that
  follows the page contract.
