# @relate/mcp

> [!WARNING]
>
> Scaffold only. No implementation, executable or public exports exist yet.
> Workspace dependencies record the intended package relationships.

MCP server adapter and a separate MCP client entry point.

## Planned responsibility

Expose a composed runtime to AI agents over the Model Context Protocol. For each
object in the graph the server offers `get`, `query` and `traverse` tools, plus
one tool per registered action. Tool inputs and outputs use the
`@relate/protocol` shapes, so an agent sees the same data, evidence and
sanitized errors as any other consumer, and only what the authenticated caller
may see.

The root README shows the intended entry point as an API preview:

```ts
// Preview: not implemented.
serveMcp(relate, { principal: (req) => authenticate(req) });
```

Object `label`, `pluralLabel` and `description` from the compiled model are
intended to describe tools to agents. A separate client entry point is planned
for Relate applications that consume other MCP servers.

## How it will fit

- Depends on `@relate/runtime` (execution) and `@relate/protocol` (shapes).
- Fourth step in the implementation sequence, after the HTTP transport, and
  reusing the same consumer operations rather than a second code path.

Tool names, schemas and the client entry point are not fixed. See
[`@relate/node`](../node/README.md) for the embedded behavior the adapter will
preserve.
