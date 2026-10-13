import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { expect, it, onTestFinished } from 'vitest';
import {
  BindingUnavailableError,
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';

async function connect(bindGraph: () => never) {
  const handler = createStreamableHttpHandler({
    executor: createDevelopmentExecutor(),
    bindGraph,
  });
  const client = new Client({ name: 'unavailable-test', version: '1' });

  onTestFinished(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => handler(new Request(input, init)),
    }),
  );

  return client;
}

it('forwards a BindingUnavailableError from both tools after a successful handshake', async () => {
  const client = await connect(() => {
    throw new BindingUnavailableError(
      'The runtime is restarting; retry shortly',
      { retryable: true },
    );
  });

  const tools = await client.listTools();
  const discover = await client.callTool({ name: 'discover', arguments: {} });
  const execute = await client.callTool({
    name: 'execute',
    arguments: { code: 'return 1;' },
  });
  const error = {
    code: 'binding-unavailable',
    message: 'The runtime is restarting; retry shortly',
    retryable: true,
  };

  expect(tools.tools).toHaveLength(2);
  expect(discover).toMatchObject({
    isError: true,
    structuredContent: { error },
  });
  expect(execute).toMatchObject({
    isError: true,
    structuredContent: {
      status: 'failed',
      logs: [],
      error: { name: 'BindingUnavailableError', ...error },
    },
  });
});

it('keeps other binding failures sanitized', async () => {
  const handler = createStreamableHttpHandler({
    executor: createDevelopmentExecutor(),
    bindGraph: () => {
      throw new Error('connection string postgres://secret');
    },
  });
  const response = await handler(
    new Request('http://localhost/mcp', { method: 'POST', body: '{}' }),
  );

  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('secret');
});
