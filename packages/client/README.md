# @relate/client

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

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

**TODO — open decision before implementing the client:** decide where shared
consumer types (`Consumer`, `QueryResult`) and the `createQuery` pagination
helper belong. They currently live in `@relate/node` and `@relate/runtime`. A
browser-safe `relate/consumer` entry point is one option, not an agreed API.
Avoid duplicating these contracts or importing the engine into the browser;
review the client dependency policy when choosing their home. This decision does
not require merging the Node and runtime packages.

- Depends only on `@relate/protocol`.
- Pairs with `@relate/http`; both are the third step in the implementation
  sequence, after the embedded path is complete.
- The [inspector specification](../../apps/inspector/SPEC.md) uses this client
  for consumer screens so the browser exercises the same contracts customers
  use.

No request or type shape is fixed yet. See
[`@relate/protocol`](../protocol/README.md) for the shapes the client will
carry.
