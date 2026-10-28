import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRunner } from '../dist/process.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'relate-datafusion-process-'));

  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'worker');

  await writeFile(executable, `#!${process.execPath}\n${body}\n`, {
    mode: 0o755,
  });
  const diagnostics: { kind: string; message: string }[] = [];
  const runner = createRunner({
    executable,
    startupTimeoutMs: 5000,
    onDiagnostic(item) {
      diagnostics.push(item);
      throw new Error('observer');
    },
  });

  cleanup.push(() => runner.close());

  return { runner, diagnostics };
}

const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
});

it.each(['abort', 'timeout', 'close'] as const)(
  'joins process teardown on %s and prevents work after retirement',
  async (mode) => {
    const { runner } = await fixture(
      `console.log(JSON.stringify({kind:'ready'})); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    let stopped: Promise<void> | undefined;
    const pending = runner.run(
      {},
      {
        signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 20 : 1000,
        onTiming(timing) {
          if (timing.stage === 'connectionStartup' && mode !== 'timeout') {
            if (mode === 'abort') controller.abort();
            else stopped = runner.close();
          }
        },
      },
    );

    await expect(pending).rejects.toMatchObject(
      mode === 'timeout'
        ? { code: 'execution-failed' }
        : { name: 'AbortError' },
    );
    await stopped;
    await runner.close();
    await expect(runner.run({}, options())).rejects.toMatchObject({
      code: 'execution-failed',
      retryable: false,
    });
  },
);
it.each([
  `console.log('not json')`,
  `console.log(JSON.stringify({kind:'result', value:{}}))`,
  `console.log(JSON.stringify({kind:'ready'})); console.log(JSON.stringify({kind:'ready'}))`,
  `console.log(JSON.stringify({kind:'ready'})); process.stdout.write('x'.repeat(17*1024*1024))`,
  `process.exit(1)`,
])(
  'rejects malformed or incomplete protocol and bounds output',
  async (body) => {
    const { runner, diagnostics } = await fixture(body);

    await expect(runner.run({}, options())).rejects.toMatchObject({
      code: 'execution-failed',
    });
    expect(diagnostics.length).toBeGreaterThan(0);
  },
);
it('waits for successful process exit and records startup before execution', async () => {
  const { runner } = await fixture(
    `console.log(JSON.stringify({kind:'ready'})); console.log(JSON.stringify({kind:'result',value:42})); setTimeout(() => process.exit(0), 30)`,
  );
  const stages: string[] = [];
  const result = await runner.run(
    {},
    {
      ...options(),
      onTiming: (t) => {
        stages.push(t.stage);
      },
    },
  );

  expect(result).toEqual({ value: 42, readAt: expect.stringMatching(/Z$/) });
  expect(stages).toEqual(['connectionStartup', 'execution']);
});
it('prevents admission after abort, bounds requests, and sanitizes errors', async () => {
  const { runner } = await fixture(
    `console.log(JSON.stringify({kind:'failure',detail:'private-secret-path'}))`,
  );
  const signal = AbortSignal.abort();

  expect(() => runner.run({}, { ...options(), signal })).toThrow();
  await expect(
    runner.run('x'.repeat(9 * 1024 * 1024), options()),
  ).rejects.toMatchObject({ retryable: false });
  const error = await runner.run({}, options()).catch((error) => error);

  expect(error.message).toBe('Analytical execution failed');
  expect(JSON.stringify(error)).not.toContain('private-secret-path');
});

it('stops a real native process when its parent pipe disappears during S3 startup', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const server = createServer();
  const sockets = new Set<import('node:net').Socket>();

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const request = new Promise<void>((resolve) =>
    server.once('request', () => resolve()),
  );
  const child = spawn(
    fileURLToPath(
      new URL('../engine/target/debug/relate-datafusion', import.meta.url),
    ),
    [],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  try {
    child.stdin.write(
      JSON.stringify({
        source: {
          kind: 'parquet',
          url: 's3://test/events.parquet',
          s3: {
            bucket: 'test',
            region: 'us-east-1',
            endpoint: `http://127.0.0.1:${port}`,
            accessKeyId: 'local',
            secretAccessKey: 'local',
            allowHttp: true,
          },
        },
        columns: {},
        operation: { kind: 'describe' },
      }) + '\n',
    );
    await request;
    child.stdin.end();
    expect(await exit).toBe(0);
  } finally {
    child.kill('SIGKILL');
    await exit;

    for (const socket of sockets) socket.destroy();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
