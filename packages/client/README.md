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
function or another service calls `get`, `query`, `traverse` and actions and
receives the same `@relate/protocol` results and evidence as an embedded
`@relate/node` consumer, with the same `ok` / `not-found` discrimination and
per-field evidence.

Constraints the package will keep:

- Browser safe: no Node, runtime, compiler or database imports.
- It carries credentials; it does not decide authorization. The server applies
  the graph's policies to the authenticated principal.

## How it will fit

The client implements the `ConsumerOperations` contract from `@relate/protocol`
over HTTP and hands it to the shared facade in `relate/consumer`. It does not
own a typed API of its own:

```ts
import { createConsumer } from 'relate/consumer';
import type { ConsumerOperations } from '@relate/protocol';

// Planned: fetch the actor's discovery snapshot once, then bind every operation.
declare function createHttpOperations(options: {
  baseUrl: string;
  credentials: unknown;
}): Promise<ConsumerOperations>;

// A generated ConsumerDescription and generated types replace the authored graph.
const consumer = createConsumer(
  description,
  await createHttpOperations({ baseUrl: '/api', credentials }),
);
const page = await consumer.objects.Customer.query({
  where: { status: 'active' },
});
```

- Depends on `@relate/protocol` (wire shapes and the operations contract) and
  `relate` / `relate/consumer` (graph types and the typed facade). Both `relate`
  entry points are browser safe; `pnpm check:boundaries` enforces that they
  never reach the compiler.
- `Consumer`, `QueryResult` and `createQuery` are shared with `@relate/node`
  through `relate/consumer`; the client never duplicates them or imports the
  engine. The facade routes from a `ConsumerDescription`, so a client needs only
  that description and generated types, not the authoring graph.
- Its discovery snapshot and operations must belong to the same authenticated
  identity and model; `GraphDescription.definitionRevision` lets the client
  detect model drift against `meta.definitionRevision` on reads.
- Pairs with the planned `@relate/http` adapter, which serves the same
  `ConsumerOperations` from `relate.operations(principal)`.
- The [inspector specification](../../apps/inspector/SPEC.md) proposes this
  client for future consumer screens. The current model graph does not use it.

No request or route shape is fixed yet. See
[`@relate/protocol`](../protocol/README.md) for the shapes the client will
carry.
