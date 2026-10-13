import { createServer } from 'node:http';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';
import type { ExecutionResult } from '@relate/mcp';
import { createFixture } from './fixture.js';

it('cancels on a dropped HTTP connection and prevents later action dispatch', async () => {
  const { binding } = await createFixture(onTestFinished);
  let started!: () => void;
  let completed!: (result: ExecutionResult) => void;
  const executing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const execution = new Promise<ExecutionResult>((resolve) => {
    completed = resolve;
  });
  const invoke = vi.fn(binding.operations.invoke);
  const graph = {
    ...binding,
    operations: {
      ...binding.operations,
      invoke,
      get: async () => {
        started();

        return { status: 'not-found' as const };
      },
    },
  };
  const delegate = createDevelopmentExecutor();
  const handler = createStreamableHttpHandler({
    executor: {
      async execute(request) {
        const result = await delegate.execute(request);

        completed(result);

        return result;
      },
    },
    bindGraph: () => graph,
  });
  // The HTTP host maps socket lifetime to the Fetch Request signal.
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();

    outgoing.on('close', () => {
      if (!outgoing.writableEnded) controller.abort();
    });

    try {
      const chunks: Buffer[] = [];

      for await (const chunk of incoming) chunks.push(chunk as Buffer);

      const response = await handler(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-11-25',
          },
          body: Buffer.concat(chunks).toString(),
          signal: controller.signal,
        }),
      );

      if (!outgoing.destroyed) {
        outgoing.writeHead(response.status);
        outgoing.end(await response.text());
      }
    } catch {
      if (!outgoing.destroyed) {
        outgoing.writeHead(500);
        outgoing.end();
      }
    }
  });
  const controller = new AbortController();

  onTestFinished(async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const response = fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: 'POST',
    signal: controller.signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: {
          code: `
      console.log(JSON.stringify({pid: process.pid, cwd: process.cwd()}));
      await graph.objects.Note.get('ready');
      await new Promise(resolve => setTimeout(resolve, 1000));
      await graph.actions.addNote({input: {text: 'must not run'}, idempotencyKey: 'after-disconnect'});
    `,
        },
      },
    }),
  }).catch(() => undefined);

  await executing;
  controller.abort();
  await response;
  const result = await execution;

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'aborted' },
  });
  const { pid, cwd } = JSON.parse(result.logs.map((log) => log.text).join(''));

  expect(() => process.kill(pid, 0)).toThrow();
  await expect(access(cwd)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
