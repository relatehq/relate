# @relate/mcp

> Development baseline (`0.0.0-dev.0`). APIs may change. Packages are not yet
> published.

Two MCP tools over actor-bound Relate operations:

- `discover({})`: visible graph overview and JavaScript usage instructions.
- `execute({ code })`: run an async function body with `graph` injected; return
  a JSON result, captured stdout/stderr, or an error.

```ts
import { compile } from 'relate/compiler';
import {
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';

const handleMcp = createStreamableHttpHandler({
  executor: createDevelopmentExecutor(),
  async bindGraph(request) {
    const actor = await authenticate(request); // Host-owned authentication.
    if (!actor) return new Response('Unauthorized', { status: 401 });
    return {
      description: compile(graph).consumer,
      operations: runtime.operations(actor),
    };
  },
});
// Mount handleMcp(Request): Promise<Response> at /mcp in your HTTP host.
```

`connectStdio({ executor, bindGraph })` registers the same tools for stdio.
`CodeExecutor` is replaceable; the supplied fresh-Node-process implementation is
**for trusted development code, not a security sandbox**. It can access Node,
the filesystem and network with the host user's permissions. Timeout/abort does
not roll back graph actions already dispatched.

Read the [MCP guide and execution flow](../../apps/docs/content/runtime/mcp.md)
and [package contract](./CONTRACT.md). The adapter uses MCP SDK transports with
protocol revisions 2025-03-26, 2025-06-18 and 2025-11-25.

From the repository root:

```sh
pnpm build
pnpm --filter @relate/mcp example
pnpm --filter @relate/mcp test
pnpm --filter @relate/mcp test:packaging
```

The example runs discovery → query → action against a real in-memory graph. Add
`--stdio` when launching `examples/discovery-query-action.ts` with `tsx` to
connect a local MCP client.
