# @relate/mcp

> Development baseline (`0.0.0-dev.0`), for discussion and contribution only.
> Not ready for application use. APIs and behavior are incomplete and may change
> without notice.

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

Object `label`, `pluralLabel` and `description` from the compiled model are
intended to describe tools to agents. A separate client entry point is planned
for Relate applications that consume other MCP servers.

## How it will fit

- Depends on `@relate/runtime` (execution) and `@relate/protocol` (shapes).
- Serves the `ConsumerOperations` contract from `@relate/protocol`, obtained
  from `relate.operations(principal)`; its `discovery` supplies tool names and
  descriptions. The adapter never reaches into the engine or the typed facade.
- Reuses the embedded consumer operations and actor-bound discovery. MCP is the
  next major interface described in the [root roadmap](../../README.md#status);
  no HTTP-first implementation order is required by this scaffold.

Tool names, schemas and the client entry point are not fixed. See
[`@relate/node`](../node/README.md) for the embedded behavior the adapter will
preserve.
