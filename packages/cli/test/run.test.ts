/** Exercise command ownership without sending signals to the test process. */
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DevStartError, startDev } from '@relate/dev';
import type { DevService } from '@relate/dev';
import { runDev } from '../src/commands/dev/run.js';
import { openBrowser } from '../src/commands/dev/open.js';

vi.mock('@relate/dev', async (original) => ({
  ...(await original<typeof import('@relate/dev')>()),
  startDev: vi.fn(),
}));
vi.mock('../src/commands/dev/open.js', () => ({ openBrowser: vi.fn() }));

afterEach(() => vi.resetAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

function command(argv: string[] = []) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errors = '';

  stderr.on('data', (chunk) => {
    errors += String(chunk);
  });

  return {
    run: () => runDev({ argv, cwd: process.cwd(), env: {}, stdout, stderr }),
    errors: () => errors,
  };
}

function service(close = vi.fn(async () => {})): DevService {
  return {
    kind: 'started',
    project: { root: '/project', configPath: '/project/relate.config.ts' },
    inspectorUrl: 'http://127.0.0.1:4318/',
    mcpUrl: 'http://127.0.0.1:4318/mcp',
    pid: process.pid,
    close,
  };
}

it('leaves default signals intact throughout startup, then handles and removes them', async () => {
  const pending = deferred<DevService>();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const before = signals.map((signal) => process.listeners(signal));
  const dev = service();
  const cli = command();

  vi.mocked(startDev).mockReturnValueOnce(pending.promise);
  const result = cli.run();

  expect(signals.map((signal) => process.listeners(signal))).toEqual(before);
  pending.resolve(dev);
  await vi.waitFor(() =>
    expect(process.listenerCount('SIGINT')).toBe(before[0]!.length + 1),
  );
  // Invoke only the command's handler, leaving any test-runner handlers alone.
  process.listeners('SIGINT').at(-1)!('SIGINT');

  await expect(result).resolves.toBe(0);
  expect(dev.close).toHaveBeenCalledWith({ immediate: false });
  expect(signals.map((signal) => process.listeners(signal))).toEqual(before);
});

it('handles a failed shutdown while browser opening is pending without rejecting early', async () => {
  const opening = deferred<void>();
  const failure = new AggregateError(
    [new Error('dispose failed')],
    'Could not close service',
  );
  const close = vi.fn().mockRejectedValue(failure);
  const cli = command(['--open']);

  vi.mocked(startDev).mockResolvedValueOnce(service(close));
  vi.mocked(openBrowser).mockReturnValueOnce(opening.promise);
  const result = cli.run();

  await vi.waitFor(() => expect(openBrowser).toHaveBeenCalled());
  process.listeners('SIGINT').at(-1)!('SIGINT');
  // Let Node run its unhandled-rejection check before the browser resolves.
  await new Promise((resolve) => setTimeout(resolve, 20));
  opening.resolve();

  await expect(result).resolves.toBe(1);
  expect(cli.errors()).toBe('  error  Could not close service\n');
});

it('formats a shutdown failure after the command is waiting for a signal', async () => {
  const cli = command();
  const close = vi.fn().mockRejectedValue(new Error('shutdown failed'));
  const before = process.listenerCount('SIGTERM');

  vi.mocked(startDev).mockResolvedValueOnce(service(close));
  const result = cli.run();

  await vi.waitFor(() =>
    expect(process.listenerCount('SIGTERM')).toBe(before + 1),
  );
  process.listeners('SIGTERM').at(-1)!('SIGTERM');

  await expect(result).resolves.toBe(1);
  expect(cli.errors()).toBe('  error  shutdown failed\n');
});

it('formats startup errors and structured lock details in the command adapter', async () => {
  const cli = command();

  vi.mocked(startDev).mockRejectedValueOnce(
    new DevStartError('Owner cannot be verified', {
      reason: 'Owner cannot be verified',
      path: '/project/.relate/dev/lock',
    }),
  );

  await expect(cli.run()).resolves.toBe(1);
  expect(cli.errors()).toContain(
    '  error  Owner cannot be verified\n         Lock: /project/.relate/dev/lock\n',
  );
});
