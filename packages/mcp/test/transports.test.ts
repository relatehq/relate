import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createMcpServer,
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';
import type { CodeExecutor } from '@relate/mcp';
import { createFixture } from './fixture.js';

it('serves exactly discover and execute over Streamable HTTP, with a fresh caller binding per request', async () => {
  const { binding, hidden } = await createFixture(onTestFinished);
  const bindGraph = vi.fn((request: Request) =>
    request.headers.get('authorization') === 'Bearer writer' ? binding : hidden,
  );
  const handler = createStreamableHttpHandler({
    executor: createDevelopmentExecutor(),
    bindGraph,
  });
  const client = new Client({ name: 'test', version: '1' });

  onTestFinished(() => client.close());
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost/mcp'),
    {
      requestInit: { headers: { authorization: 'Bearer writer' } },
      fetch: (input, init) => handler(new Request(input, init)),
    },
  );

  await client.connect(transport);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    'discover',
    'execute',
  ]);
  const discovery = await client.callTool({ name: 'discover', arguments: {} });

  expect(discovery.structuredContent).toMatchObject({
    graph: { objects: { Note: {} }, actions: { addNote: {} } },
    instructions: expect.stringContaining('graph.objects'),
  });
  const query = await client.callTool({
    name: 'execute',
    arguments: {
      code: 'const page = await graph.objects.Note.query(); console.log("read", page.data.length); return page.data.length;',
    },
  });

  expect(query.structuredContent).toMatchObject({
    status: 'succeeded',
    result: 1,
    logs: [{ stream: 'stdout', text: 'read 1\n' }],
  });
  const action = await client.callTool({
    name: 'execute',
    arguments: {
      code: 'return await graph.actions.addNote({input: {text: "via MCP"}, idempotencyKey: "mcp"});',
    },
  });

  expect(action.structuredContent).toMatchObject({
    status: 'succeeded',
    result: { state: 'succeeded' },
  });
  const failed = await client.callTool({
    name: 'execute',
    arguments: { code: 'throw new Error("bad JS");' },
  });

  expect(failed).toMatchObject({
    isError: true,
    structuredContent: { status: 'failed', error: { message: 'bad JS' } },
  });
  expect(bindGraph.mock.calls.length).toBeGreaterThanOrEqual(6);
  const outsider = new Client({ name: 'outsider', version: '1' });

  onTestFinished(() => outsider.close());
  await outsider.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => handler(new Request(input, init)),
    }),
  );
  expect(
    (await outsider.callTool({ name: 'discover', arguments: {} }))
      .structuredContent,
  ).toMatchObject({ graph: { objects: {}, actions: {} } });
});

it('requires host authentication, rejects unapproved origins, and uses the replaceable executor', async () => {
  const { binding } = await createFixture(onTestFinished);
  const execute = vi.fn<CodeExecutor['execute']>().mockResolvedValue({
    status: 'succeeded',
    result: 'replacement',
    logs: [],
  });
  const bindGraph = vi.fn((request: Request) =>
    request.headers.get('authorization')
      ? binding
      : new Response('Unauthorized', { status: 401 }),
  );
  const handler = createStreamableHttpHandler({
    executor: { execute },
    bindGraph,
    allowedOrigins: ['https://app.example'],
  });

  expect((await handler(new Request('http://localhost/mcp'))).status).toBe(401);
  expect(
    (
      await handler(
        new Request('http://localhost/mcp', {
          headers: { origin: 'https://evil.example', authorization: 'writer' },
        }),
      )
    ).status,
  ).toBe(403);
  expect(bindGraph).toHaveBeenCalledTimes(1);
  expect(
    (
      await handler(
        new Request('http://localhost/mcp', {
          headers: { authorization: 'writer' },
        }),
      )
    ).status,
  ).toBe(405);
  const client = new Client({ name: 'replacement', version: '1' });

  onTestFinished(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      requestInit: {
        headers: { authorization: 'writer', origin: 'https://app.example' },
      },
      fetch: (input, init) => handler(new Request(input, init)),
    }),
  );
  expect(
    (
      await client.callTool({
        name: 'execute',
        arguments: { code: 'return 123;' },
      })
    ).structuredContent,
  ).toMatchObject({ result: 'replacement' });
  expect(execute).toHaveBeenCalledWith({
    code: 'return 123;',
    graph: binding,
    signal: expect.any(AbortSignal),
  });
  await client.callTool({ name: 'execute', arguments: { code: 123 } });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('serves the same tools over a real stdio subprocess without mixing execution logs into protocol output', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      fileURLToPath(new URL('./stdio-host.ts', import.meta.url)),
    ],
    stderr: 'pipe',
  });

  onTestFinished(() => client.close());
  await client.connect(transport);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    'discover',
    'execute',
  ]);
  expect(
    (await client.callTool({ name: 'discover', arguments: {} }))
      .structuredContent,
  ).toMatchObject({ graph: { objects: { Note: {} } } });
  expect(
    (
      await client.callTool({
        name: 'execute',
        arguments: {
          code: 'console.log("protocol stays clean"); return (await graph.objects.Note.query()).data.length;',
        },
      })
    ).structuredContent,
  ).toMatchObject({
    status: 'succeeded',
    result: 1,
    logs: [{ text: 'protocol stays clean\n' }],
  });
  expect(
    (
      await client.callTool({
        name: 'execute',
        arguments: {
          code: 'return await graph.actions.addNote({input: {text: "stdio"}, idempotencyKey: "stdio"});',
        },
      })
    ).structuredContent,
  ).toMatchObject({ status: 'succeeded', result: { state: 'succeeded' } });
});

it.each(['cancellation', 'server closure'])(
  'forwards %s to the replaceable executor',
  async (mode) => {
    const { binding } = await createFixture(onTestFinished);
    let startedResolve!: () => void;
    let stoppedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      stoppedResolve = resolve;
    });
    const executor: CodeExecutor = {
      execute: ({ signal }) =>
        new Promise((resolve) => {
          signal!.addEventListener(
            'abort',
            () => {
              stoppedResolve();
              resolve({
                status: 'failed',
                logs: [],
                error: { name: 'Error', code: 'aborted', message: 'aborted' },
              });
            },
            { once: true },
          );
          startedResolve();
        }),
    };
    const server = createMcpServer({ executor, bindGraph: () => binding });
    const client = new Client({ name: 'cancellation-test', version: '1' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    onTestFinished(async () => {
      await client.close();
      await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const result = client
      .callTool(
        { name: 'execute', arguments: { code: 'pending' } },
        { signal: controller.signal },
      )
      .catch(() => undefined);

    await started;

    if (mode === 'cancellation') controller.abort();
    else await server.close();

    await stopped;
    await result;
  },
);
