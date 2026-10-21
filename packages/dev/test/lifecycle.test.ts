/** Service lifecycle with real builds/workers and controlled file-change events.
 * The listener stays unbound; CLI process tests cover TCP, OS watching and signals.
 */
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { createInspectorApp } from '@relate/inspector/server';
import { startDev } from '../src/start.js';
import type { DevServiceEvent } from '../src/start.js';
import { bindLoopback } from '../src/listener.js';
import { lockPath } from '../src/lock.js';

const changes = vi.hoisted(() => ({
  notify: (_files: readonly string[]) => {},
}));

vi.mock('../src/watcher.js', () => ({
  createWatcher: vi.fn(
    (options: { onChange: (files: readonly string[]) => void }) => {
      changes.notify = options.onChange;

      return { update() {}, close() {} };
    },
  ),
}));

vi.mock('../src/listener.js', () => ({
  bindLoopback: vi.fn(async (createServer: () => Server) => {
    const server = createServer();

    vi.spyOn(server, 'close');

    return { server, port: 4318, url: 'http://127.0.0.1:4318', notice: null };
  }),
}));

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.clearAllMocks();
});

async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'relate-lifecycle-test-'));

  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    join(cwd, 'node_modules'),
  );
  const config = join(cwd, 'relate.config.ts');
  const source = `import { defineAccess, defineGraph } from 'relate';
export default defineGraph({ id: 'demo', objects: {}, access: defineAccess({ roles: [], fieldGroups: ['ordinary'], claims: {} }), policies: {} });`;

  await writeFile(config, source);

  // Build the worker from the same source tree as startDev, never stale dist.
  const workerPath = join(cwd, 'worker.mjs');

  await build({
    entryPoints: [fileURLToPath(new URL('../src/worker.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
  });

  return { cwd, config, source, workerPath };
}

it('keeps one service through builds and diagnostics, without owning process signals', async () => {
  const app = await project();
  const events: DevServiceEvent[] = [];
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  const dev = await startDev({
    cwd: app.cwd,
    runtime: false,
    env: {},
    onEvent: (event) => events.push(event),
    workerPath: app.workerPath,
  });

  cleanups.push(() => dev.close());
  expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
    before,
  );
  await vi.waitFor(
    () =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'ready', generation: 1 }),
      ),
    { timeout: 5000 },
  );

  await writeFile(app.config, 'export default !!!');
  changes.notify([app.config]);
  await vi.waitFor(
    () =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'diagnostics', keptGeneration: 1 }),
      ),
    { timeout: 5000 },
  );
  await writeFile(app.config, app.source);
  changes.notify([app.config]);
  await vi.waitFor(
    () =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'update', generation: 2 }),
      ),
    { timeout: 5000 },
  );
  expect(bindLoopback).toHaveBeenCalledTimes(1);
  expect(events.filter((event) => event.type === 'listening')).toHaveLength(1);

  await Promise.all([dev.close(), dev.close()]);
  await expect(readFile(lockPath(app.cwd))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('releases resources and the project lock after a startup failure', async () => {
  const app = await project();

  await expect(
    startDev({
      cwd: app.cwd,
      runtime: false,
      env: {},
      inspector: createInspectorApp({
        assetsDirectory: join(app.cwd, 'missing-assets'),
      }),
    }),
  ).rejects.toThrow('Inspector assets are missing');
  const bound = await vi.mocked(bindLoopback).mock.results[0]!.value;

  expect(bound.server.close).toHaveBeenCalledTimes(1);
  await expect(readFile(lockPath(app.cwd))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const dev = await startDev({
    cwd: app.cwd,
    runtime: false,
    env: {},
    workerPath: app.workerPath,
  });

  cleanups.push(() => dev.close());
  expect(dev.kind).toBe('started');
  await dev.close({ immediate: true });
});

it('preserves the startup error when cleanup also fails and still releases the lock', async () => {
  const app = await project();
  const originalBind = vi.mocked(bindLoopback).getMockImplementation()!;
  const cleanupError = new Error('listener cleanup failed');

  vi.mocked(bindLoopback).mockImplementationOnce(async (...args) => {
    const bound = await originalBind(...args);

    vi.mocked(bound.server.close).mockImplementationOnce(() => {
      throw cleanupError;
    });

    return bound;
  });

  await expect(
    startDev({
      cwd: app.cwd,
      runtime: false,
      env: {},
      inspector: createInspectorApp({
        assetsDirectory: join(app.cwd, 'missing-assets'),
      }),
    }),
  ).rejects.toThrow('Inspector assets are missing');
  await expect(readFile(lockPath(app.cwd))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
