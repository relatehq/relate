import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { createMcpServer } from './server.js';
import type { McpServerOptions } from './server.js';
import type { CodeExecutor, GraphBinding } from './executor.js';

export interface HttpOptions {
  executor: CodeExecutor;
  /** Called on EVERY HTTP request. Return an authentication response (e.g. 401) or actor-bound operations. */
  bindGraph(
    request: Request,
  ): GraphBinding | Response | Promise<GraphBinding | Response>;
  /** Exact permitted browser origins. Present origins are denied by default. */
  allowedOrigins?: readonly string[];
}

/** Stateless Streamable HTTP with JSON responses; mount at the host's /mcp endpoint. */
export function createStreamableHttpHandler(
  options: HttpOptions,
): (request: Request) => Promise<Response> {
  const origins = new Set(options.allowedOrigins ?? []);

  return async (request) => {
    const origin = request.headers.get('origin');

    if (origin !== null && !origins.has(origin))
      return new Response('Forbidden origin', { status: 403 });

    let graph: GraphBinding | Response;

    try {
      graph = await options.bindGraph(request);
    } catch {
      return new Response('Authentication or graph binding failed', {
        status: 500,
      });
    }

    if (graph instanceof Response) return graph;

    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { Allow: 'POST' } });

    const binding = graph;
    const server = createMcpServer({
      executor: options.executor,
      signal: request.signal,
      bindGraph: () => binding,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);

      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  };
}

/** Host authentication selects the actor; stdout is reserved exclusively for MCP. */
export async function connectStdio(
  options: McpServerOptions & { input?: Readable; output?: Writable },
) {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport(options.input, options.output);

  await server.connect(transport);

  return server;
}
