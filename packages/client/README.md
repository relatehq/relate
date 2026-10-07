# @relate/client

> [!WARNING]
>
> Scaffold only. No implementation, executable or public exports exist yet.
> Workspace dependencies record the intended package relationships.

HTTP client for browser and server consumers.

## Planned responsibility

A typed client for the `@relate/http` API. A consumer in a browser, an edge
function or another service calls `get`, `traverse` and actions and receives the
same `@relate/protocol` results and evidence as an embedded `@relate/node`
consumer, with the same `ok` / `not-found` discrimination and per-field
evidence.

Constraints the package will keep:

- Browser safe: no Node, runtime, compiler or database imports.
- It carries credentials; it does not decide authorization. The server applies
  the graph's policies to the authenticated principal.

## How it will fit

- Depends only on `@relate/protocol`.
- Pairs with `@relate/http`; both are the third step in the implementation
  sequence, after the embedded path is complete.
- The [inspector specification](../../apps/inspector/SPEC.md) uses this client
  for consumer screens so the browser exercises the same contracts customers
  use.

No request or type shape is fixed yet. See
[`@relate/protocol`](../protocol/README.md) for the shapes the client will
carry.
