# @relate/http

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

> [!WARNING]
>
> Scaffold only. No implementation, executable or public exports exist yet.
> Workspace dependencies record the intended package relationships.

Direct HTTP API over narrow runtime consumer capabilities.

## Planned responsibility

Expose the consumer operations of a composed runtime over HTTP: `get`, `query`,
`traverse`, actions, receipts and discovery. Requests and responses use the
`@relate/protocol` shapes unchanged, so a remote caller receives the same
results, evidence and sanitized errors as an embedded `@relate/node` consumer.

The surface stays narrow by design:

- Only consumer operations. Trusted host operations such as `adopt`, and
  development diagnostics, are not routes.
- The application owns the HTTP listener, authentication and shutdown. The
  adapter receives an already authenticated principal for each request and
  applies the runtime's default-deny authorization.

## How it will fit

The adapter serves the `ConsumerOperations` contract from `@relate/protocol`. It
never reaches into the engine or the typed facade: a host hands it the
operations bound to each request's principal.

```ts
import { createRuntime } from '@relate/node';

const relate = createRuntime({ graph, connections });

// Planned: one adapter per runtime; the host resolves the principal per request.
app.route(
  '/api',
  createHttpAdapter({
    operations: (principal) => relate.operations(principal),
  }),
);
```

- Depends on `@relate/runtime` (the `Principal` type and engine semantics) and
  `@relate/protocol` (wire shapes and the operations contract). It works for
  apps composed with `@relate/node` through `relate.operations(principal)` and
  for a bare `@relate/runtime` engine through the same contract.
- Paired with `@relate/client`, which implements `ConsumerOperations` over HTTP
  and reuses the `relate/consumer` facade.
- The [inspector specification](../../apps/inspector/SPEC.md) describes a future
  development worker serving this package behind a supervisor proxy at `/api`.
  Today's Inspector compiles definitions only and does not serve consumer reads.

No request or route shape is fixed yet. The behavior to preserve is defined by
the embedded path; see [`@relate/node`](../node/README.md).
