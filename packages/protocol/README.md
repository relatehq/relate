# @relate/protocol

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

Transport-neutral request, result, evidence and error shapes shared by every
Relate consumer surface. Private and unpublished.

## Responsibility

- Requests: `ReadControls` owns `evidence`, `select`, `maxAgeMs`, `refresh`,
  `stale`, `requireComplete` and `timeoutMs`. `CollectionReadControls` adds
  `limit`, `cursor` and `where`. `ObjectReadRequest` and `ObjectQueryRequest`
  extend object reads independently of `TraversalRequest`. `ReadRequest` and
  `QueryRequest` remain aliases of those object-specific types.
- Results: `ObjectResult` and `ObjectRecord` (`ok` with the canonical `id`,
  partial `data` and `meta`, or `not-found`), `Page<T>` with `PageMeta`, and the
  engine-level `ReadResult`.
- Evidence: compact by default, or `evidence: 'full'` for each selected field:
  availability, freshness, source identity, retention, ordering and refresh
  outcome.
- Errors and receipts: `ReadError` and `ActionError` with sanitized codes and no
  private detail, and successful/declared-failure receipts (`SucceededReceipt`,
  `FailedReceipt`, `ActionReceipt`).
- Discovery: compact `GraphDescription` with name-keyed `ObjectOverview` and
  `ActionOverview` maps, `TraversalOverview` edges and shared `SdkDescription`;
  option applicability (`SdkOptionDescription`, `ReadOperation`), detailed
  `ObjectDescription`, `ActionDescription` and portable `ScalarSchema`, plus the
  actor-bound `Discovery` interface.
- `ConsumerOperations`: the actor-bound, definition-ID-addressed operations
  every consumer surface shares (`get`, `query`, `traverse`, `invoke`,
  `getReceipt`, `discovery`), each returning the complete public result. The
  engine implements it, the planned `@relate/http` serves it, and the planned
  `@relate/client` implements it over a transport, and `relate/consumer` types
  it.
- `Json`.

These are types, two error classes and pure evidence presentation helpers. The
package has no runtime, database, provider or schema-library dependency and
performs no validation itself.

## How it fits

- Dependencies: none.
- `relate` uses these shapes for `assertFields`, typed results and the
  `relate/consumer` facade; `relate/model` validates manifests against
  `ScalarSchema`. `@relate/runtime` produces results and discovery.
  `@relate/node` binds the engine to `ConsumerOperations` per principal.
- The implemented `@relate/mcp` exposes these operations through `discover` and
  `execute` over stdio or Streamable HTTP. The standalone `@relate/http` adapter
  and `@relate/client` remain planned.

## Public API

```ts
import { ReadError } from '@relate/protocol';
import type { ObjectRecord, ObjectResult, Page } from '@relate/protocol';

function customerName(result: ObjectResult): string | undefined {
  if (result.status === 'not-found') return undefined;

  // Selection never guarantees presence: authorization or availability can
  // withhold a field. Evidence says why a value is what it is.
  const evidence = result.meta.fields?.name;

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

Results, pages, evidence, errors, discovery shapes and the consumer operations
contract are implemented and used by the engine and MCP adapter. The standalone
HTTP adapter remains planned. The types alone do not validate incoming JSON; the
runtime validates what it produces and accepts.

## Further reading

- [CONTRACT.md](./CONTRACT.md): result and evidence semantics, durability versus
  retention, and the page contract.
- [`assertFields`](../relate/CONTRACT.md#require-values-after-a-read): the
  consumer-side presence check and its narrowing rules.
- [Pagination](../relate/CONTRACT.md#pagination): the implemented helper that
  follows the page contract.

`present` renders a full resolved read, object, or page result as a compact
(default) or full response. It transforms only known evidence envelopes, never
business data, and does not perform authorization or validation. Inputs must
already be authorized, resolved `FullReadResult`, `FullObjectResult`, or
`FullPageResult` values. Responses never share evidence objects with the input.
Compact responses preserve nonempty warnings and all exceptional field evidence.
See the
[response reference](../../apps/docs/content/reference/read-responses.md).

## Local calendar datetimes

Discovery describes local calendar fields as `format: 'local-datetime'` with
`precision: 'second' | 'millisecond'` in `ScalarSchema`. Values remain strings
on the wire. See the
[owning scalar contract](../relate/CONTRACT.md#local-calendar-datetimes) for
validation, clock-domain semantics and migration requirements.
