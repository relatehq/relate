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

Expose the consumer operations of a composed runtime over HTTP: `get`,
`traverse`, actions and, once implemented, queries. Requests and responses use
the `@relate/protocol` shapes unchanged, so a remote caller receives the same
results, evidence and sanitized errors as an embedded `@relate/node` consumer.

The surface stays narrow by design:

- Only consumer operations. Trusted host operations such as `adopt`, and
  development diagnostics, are not routes.
- The application owns the HTTP listener, authentication and shutdown. The
  adapter receives an already authenticated principal for each request and
  applies the runtime's default-deny authorization.

## How it will fit

- Depends on `@relate/runtime` (execution) and `@relate/protocol` (wire shapes).
- Paired with `@relate/client`, the typed caller for browsers and servers.
- Third step in the implementation sequence, after the embedded read and native
  write path in `@relate/runtime` and `@relate/postgres` is complete. The
  [inspector specification](../../apps/inspector/SPEC.md) expects a development
  worker to serve this package behind a supervisor proxy at `/api`.

No request or route shape is fixed yet. The behavior to preserve is defined by
the embedded path; see [`@relate/node`](../node/README.md).
