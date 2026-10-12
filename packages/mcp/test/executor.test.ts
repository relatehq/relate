import { access } from 'node:fs/promises';
import { expect, it, vi, onTestFinished } from 'vitest';
import { ActionError, ReadError } from '@relate/protocol';
import { createDevelopmentExecutor } from '@relate/mcp';
import { createFixture } from './fixture.js';

it('uses the existing facade for discovery, paginated query, get, actions and receipts over IPC', async () => {
  const { binding } = await createFixture(onTestFinished);
  const executor = createDevelopmentExecutor();
  const result = await executor.execute({
    graph: binding,
    code: `
    console.log(graph.objects.Note.describe().operations.query.call);
    const rows = [];
    await graph.actions.addNote({input: {text: 'second'}, idempotencyKey: 'second'});
    for await (const note of graph.objects.Note.query({limit: 1})) rows.push(note);
    const receipt = await graph.actions.addNote({input: {text: 'third'}, idempotencyKey: 'third'});
    const fetched = await graph.objects.Note.get(rows[0].id);
    return { count: rows.length, fetched: fetched.status, receipt: await graph.receipts.get('addNote', receipt.invocationId) };
  `,
  });

  expect(result).toMatchObject({
    status: 'succeeded',
    result: { count: 2, fetched: 'ok', receipt: { state: 'succeeded' } },
  });
  expect(result.logs.map((log) => log.text).join('')).toContain(
    'objects.Note.query',
  );
});

it('only exposes actor-visible routes and metadata inside the child', async () => {
  const { hidden } = await createFixture(onTestFinished);
  const result = await createDevelopmentExecutor().execute({
    graph: hidden,
    code: 'return { objects: Object.keys(graph.objects), actions: Object.keys(graph.actions), overview: graph.describe() };',
  });

  expect(result).toMatchObject({
    status: 'succeeded',
    result: {
      objects: [],
      actions: [],
      overview: { objects: {}, actions: {} },
    },
  });
});

it('captures stdout/stderr and JavaScript errors, including syntax and non-JSON results', async () => {
  const { binding } = await createFixture(onTestFinished);
  const executor = createDevelopmentExecutor();
  const result = await executor.execute({
    graph: binding,
    code: 'console.log("hello"); console.error("oops"); throw new Error("broken");',
  });

  expect(result).toMatchObject({
    status: 'failed',
    error: { name: 'Error', message: 'broken' },
  });
  expect(result.logs).toEqual(
    expect.arrayContaining([
      { stream: 'stdout', text: 'hello\n' },
      { stream: 'stderr', text: 'oops\n' },
    ]),
  );
  expect(
    await executor.execute({ graph: binding, code: 'return (' }),
  ).toMatchObject({ status: 'failed', error: { name: 'SyntaxError' } });
  expect(
    await executor.execute({ graph: binding, code: 'return 1n;' }),
  ).toMatchObject({ status: 'failed', error: { name: 'TypeError' } });
});

it('preserves public graph error details and sanitizes unexpected host exceptions', async () => {
  const { binding } = await createFixture(onTestFinished);
  const executor = createDevelopmentExecutor();
  const query = vi.fn().mockRejectedValue(
    new ReadError('invalid-request', {
      operation: 'Note.query',
      issues: [
        { path: ['limit'], problem: 'invalid-value', message: 'bad limit' },
      ],
    }),
  );
  const graph = { ...binding, operations: { ...binding.operations, query } };
  const code =
    'try { await graph.objects.Note.query(); } catch (e) { return { name: e.name, code: e.code, issues: e.issues }; }';

  expect(await executor.execute({ graph, code })).toMatchObject({
    status: 'succeeded',
    result: {
      name: 'ReadError',
      code: 'invalid-request',
      issues: [{ message: 'bad limit' }],
    },
  });
  query.mockRejectedValue(new Error('secret database password'));
  const failed = await executor.execute({
    graph,
    code: 'return await graph.objects.Note.query();',
  });

  expect(failed).toMatchObject({
    status: 'failed',
    error: { message: 'Graph operation failed', code: 'internal' },
  });
  expect(JSON.stringify(failed)).not.toContain('secret');
  const denied = {
    ...binding,
    operations: {
      ...binding.operations,
      invoke: vi.fn().mockRejectedValue(new ActionError('denied')),
    },
  };

  expect(
    await executor.execute({
      graph: denied,
      code: 'return await graph.actions.addNote({input: {text: "x"}, idempotencyKey: "x"});',
    }),
  ).toMatchObject({
    status: 'failed',
    error: { name: 'ActionError', code: 'denied' },
  });
});

it('kills CPU loops and removes the execution directory before resolving', async () => {
  const { binding } = await createFixture(onTestFinished);
  const result = await createDevelopmentExecutor({ timeoutMs: 500 }).execute({
    graph: binding,
    code: 'console.log(JSON.stringify({pid: process.pid, cwd: process.cwd()})); while (true) {}',
  });

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'timeout' },
  });
  const { pid, cwd } = JSON.parse(result.logs.map((log) => log.text).join(''));

  expect(() => process.kill(pid, 0)).toThrow();
  await expect(access(cwd)).rejects.toThrow();
});

it('cleans up timers and has no globals, environment changes or files surviving between executions', async () => {
  const { binding } = await createFixture(onTestFinished);
  const executor = createDevelopmentExecutor();
  const first = await executor.execute({
    graph: binding,
    code: `
    globalThis.leak = 42; process.env.LEAK = 'yes';
    const fs = await import('node:fs'); fs.writeFileSync('local.txt', 'hello');
    setInterval(() => {}, 1000);
    return {pid: process.pid, cwd: process.cwd()};
  `,
  });

  expect(first.status).toBe('succeeded');

  if (first.status !== 'succeeded') throw new Error('expected success');

  const { pid, cwd } = first.result as { pid: number; cwd: string };

  expect(() => process.kill(pid, 0)).toThrow();
  await expect(access(cwd)).rejects.toThrow();
  const second = await executor.execute({
    graph: binding,
    code: `return [typeof globalThis.leak, process.env.LEAK ?? null, (await import('node:fs')).existsSync('local.txt')];`,
  });

  expect(second).toMatchObject({
    status: 'succeeded',
    result: ['undefined', null, false],
  });
});

it.each([
  'console.log("x".repeat(10000)); await new Promise(() => {});',
  'process.stderr.write("x".repeat(10000));',
  'return "x".repeat(10000);',
  'throw new Error("x".repeat(10000));',
])('enforces combined output limits: %s', async (code) => {
  const { binding } = await createFixture(onTestFinished);
  const result = await createDevelopmentExecutor({
    maxOutputBytes: 256,
  }).execute({ graph: binding, code });

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'output-limit' },
  });
  expect(
    Buffer.byteLength(result.logs.map((log) => log.text).join('')),
  ).toBeLessThanOrEqual(256);
});

it('cancels before and during execution and handles premature process exit', async () => {
  const { binding } = await createFixture(onTestFinished);
  const executor = createDevelopmentExecutor();

  expect(
    await executor.execute({
      graph: binding,
      code: 'return 1;',
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ status: 'failed', error: { code: 'aborted' } });
  const controller = new AbortController();
  const result = executor.execute({
    graph: binding,
    code: 'await new Promise(() => {});',
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 150);

  try {
    expect(await result).toMatchObject({
      status: 'failed',
      error: { code: 'aborted' },
    });
  } finally {
    clearTimeout(timer);
  }

  expect(
    await executor.execute({ graph: binding, code: 'process.exit(0);' }),
  ).toMatchObject({ status: 'failed', error: { code: 'process' } });
});

it('rejects mismatched bindings before dispatch and never retries operations after model drift', async () => {
  const { binding } = await createFixture(onTestFinished);
  const invoke = vi.fn(binding.operations.invoke);
  const describe = vi.fn(binding.operations.discovery.describe);
  const graph = {
    ...binding,
    operations: {
      ...binding.operations,
      invoke,
      discovery: { ...binding.operations.discovery, describe },
    },
  };
  const overview = binding.operations.discovery.describe();

  describe
    .mockReturnValueOnce(overview)
    .mockReturnValueOnce(overview)
    .mockReturnValue({
      ...overview,
      definitionRevision: 'sha256:' + 'a'.repeat(64),
    });
  expect(
    await createDevelopmentExecutor().execute({
      graph,
      code: 'return await graph.actions.addNote({input: {text: "x"}, idempotencyKey: "x"});',
    }),
  ).toMatchObject({ status: 'failed' });
  expect(invoke).not.toHaveBeenCalled();
  expect(
    await createDevelopmentExecutor().execute({ graph, code: 'return 1;' }),
  ).toMatchObject({ status: 'failed', error: { code: 'binding' } });
});

it('bounds waiting on graph operations and ignores their late completion after timeout', async () => {
  const { binding } = await createFixture(onTestFinished);
  let complete!: () => void;
  const query = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<typeof binding.operations.query>>>(
        (resolve) => {
          complete = () => resolve({ data: [], meta: { exhausted: true } });
        },
      ),
  );
  const graph = { ...binding, operations: { ...binding.operations, query } };
  const result = await createDevelopmentExecutor({ timeoutMs: 500 }).execute({
    graph,
    code: 'console.log(process.pid); await graph.objects.Note.query(); await graph.objects.Note.query();',
  });

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'timeout' },
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(() => process.kill(Number(result.logs[0]!.text.trim()), 0)).toThrow();
  complete();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(query).toHaveBeenCalledTimes(1);
});

it('rejects malformed child messages without throwing in the host', async () => {
  const { binding } = await createFixture(onTestFinished);
  const result = await createDevelopmentExecutor().execute({
    graph: binding,
    code: 'process.send({type: "result"}); await new Promise(() => {});',
  });

  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'protocol' },
  });
});

it('flushes buffered stdout before a successful result', async () => {
  const { binding } = await createFixture(onTestFinished);
  const result = await createDevelopmentExecutor().execute({
    graph: binding,
    code: 'process.stdout.write("x".repeat(200000)); return 1;',
  });

  expect(result).toMatchObject({ status: 'succeeded', result: 1 });
  expect(result.logs.map((log) => log.text).join('')).toBe('x'.repeat(200000));
});
