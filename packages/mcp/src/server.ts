import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { snapshotBinding } from './binding.js';
import type { CodeExecutor, GraphBinding } from './executor.js';

export const javascriptInstructions = `Use discover first. execute runs an async JavaScript function body with an injected graph consumer. Use await and an explicit return for the result; console.log/error are captured. Each execution starts fresh: variables, timers and globals do not survive. Return JSON-serializable data.
The graph overview contains actor-visible objects, relationships, actions and SDK option guidance. Use graph.describe(), graph.objects[apiName].describe(), and graph.actions[apiName].describe() for details.
Read one page: const page = await graph.objects[apiName].query({ limit: 10 }); return page;
Read all pages: for await (const record of graph.objects[apiName].query()) { console.log(record); }
Read one record: await graph.objects[apiName].get(id). Traverse: await graph.objects[apiName].traverse[edgeName](id).
Invoke: await graph.actions[apiName]({ input: { ... }, idempotencyKey: "caller-chosen-stable-key" }); inspect the action description for input fields. Look up receipts with graph.receipts.get(actionApiName, invocationId).
Graph reads and actions run as the caller. A timeout or cancellation does not roll back an action already dispatched. Never blindly retry a mutation with a new idempotency key.`;

export interface McpServerOptions {
  executor: CodeExecutor;
  /** Authenticate/bind in the host. Called afresh for every tool invocation. */
  bindGraph(context: {
    signal: AbortSignal;
  }): GraphBinding | Promise<GraphBinding>;
}

function content(
  value: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

/** Both transports register exactly these two tools. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'relate', version: '0.0.0-dev.0' },
    {
      instructions: javascriptInstructions,
      // The classic Streamable HTTP and stdio lifecycle supported by this adapter.
      supportedProtocolVersions: ['2025-11-25', '2025-06-18', '2025-03-26'],
    },
  );
  const closed = new AbortController();

  server.server.onclose = () => closed.abort();
  const signalFor = (signal: AbortSignal) =>
    AbortSignal.any([signal, closed.signal]);

  server.registerTool(
    'discover',
    {
      description:
        'Discover actor-visible graph metadata and JavaScript usage instructions.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_input, context) => {
      try {
        const graph = await options.bindGraph({
          signal: signalFor(context.mcpReq.signal),
        });
        const snapshot = snapshotBinding(graph);

        return content({
          graph: snapshot.overview,
          instructions: javascriptInstructions,
        });
      } catch {
        return content(
          {
            error: { code: 'binding', message: 'Graph binding is unavailable' },
          },
          true,
        );
      }
    },
  );
  server.registerTool(
    'execute',
    {
      description:
        'Run an async JavaScript function body with graph injected; return JSON, captured stdout/stderr, or an error. Actions may change data.',
      inputSchema: z
        .object({
          code: z
            .string()
            .min(1)
            .max(256 * 1024),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ code }, context) => {
      const signal = signalFor(context.mcpReq.signal);

      try {
        const graph = await options.bindGraph({ signal });
        const result = await options.executor.execute({ code, graph, signal });

        return content({ ...result }, result.status === 'failed');
      } catch {
        return content(
          {
            status: 'failed',
            logs: [],
            error: { code: 'internal', message: 'Execution unavailable' },
          },
          true,
        );
      }
    },
  );

  return server;
}
