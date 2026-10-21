import { expect, it, onTestFinished } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { sqlite } from '@relate/connector-sqlite';
import { startApp } from '@relate/node';
import { bind, defineApp } from 'relate';
import { compile } from 'relate/compiler';
import {
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';

it('preserves principal-specific analytical discovery through MCP HTTP and executor IPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-mcp-analytics-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.sqlite');
  const db = new DatabaseSync(path);

  db.exec(
    'CREATE TABLE events(customerId TEXT NOT NULL, amount INTEGER NOT NULL, secret TEXT NOT NULL)',
  );
  db.close();
  const { graph, Events } = createAnalyticalGraph();
  const connection = sqlite({ connectionId: 'events', path });
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        onDispose(() => connection.close());

        return { bindings: [bind(Events, connection.table('events'))] };
      },
    }),
  );

  onTestFinished(() => runtime.close());
  const description = compile(graph).consumer;
  const handler = createStreamableHttpHandler({
    executor: createDevelopmentExecutor(),
    bindGraph(request) {
      const roles =
        request.headers.get('authorization') === 'Bearer analyst'
          ? ['reader', 'analyst', 'private']
          : ['reader', 'private'];

      return {
        description,
        operations: runtime.operations({ id: 'actor', roles, claims: {} }),
      };
    },
  });

  for (const token of ['analyst', 'reader']) {
    const client = new Client({ name: 'discovery-test', version: '1' });

    onTestFinished(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (input, init) => handler(new Request(input, init)),
      }),
    );
    const response = await client.callTool({
      name: 'execute',
      arguments: { code: 'return graph.objects.Customer.describe();' },
    });
    const content = response.structuredContent as {
      status: string;
      result: Record<string, unknown>;
    };

    expect(content.status).toBe('succeeded');
    expect(content.result.properties).toContainEqual(
      expect.objectContaining({
        name: 'count',
        kind: 'computed',
        readable: token === 'analyst',
        schema: { type: 'int64', nullable: false },
      }),
    );

    if (token === 'analyst')
      expect(content.result.datasets).toMatchObject({
        events: { columns: { amount: { type: 'int64', readable: true } } },
      });
    else expect(content.result).not.toHaveProperty('datasets');

    expect(JSON.stringify(content.result)).not.toContain('"sql"');
    expect(JSON.stringify(content.result)).not.toContain(directory);
  }
});
