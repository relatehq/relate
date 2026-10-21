import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createInspectorApp } from '@relate/inspector/server';
import { startDev, lockPath } from '@relate/dev';
import type { DevService, DevServiceEvent } from '@relate/dev';
import type { SnapshotEvent } from '@relate/inspector/protocol';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function project() {
  const cwd = await mkdtemp(join(tmpdir(), 'relate-service-test-'));

  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  await symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    join(cwd, 'node_modules'),
  );
  const config = join(cwd, 'relate.config.ts');
  const source = `import { z } from 'zod';
import { defineApp, defineGraph, defineAccess, defineObject, nativeMembership, native, objectId } from 'relate';
const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: {} });
const Note = defineObject({
  id: 'notes.note', label: 'Note', membership: nativeMembership(),
  properties: { id: objectId({ id: 'note.id' }), body: native(z.string(), { id: 'note.body' }) },
});
export default defineApp({ graph: defineGraph({
  id: 'notes', objects: { Note }, access,
  policies: { Note: { read: { gate: access.role('reader') } } },
  principals: { alice: { roles: ['reader'] } },
}), setup: () => ({ connections: [] }) });
`;

  await writeFile(config, source);

  return { cwd, config, source };
}

async function session(dev: DevService) {
  const url = new URL(dev.inspectorUrl);
  const response = await fetch(`${url.origin}/dev/session`, {
    method: 'POST',
    headers: { origin: url.origin, 'content-type': 'application/json' },
    body: JSON.stringify({
      token: new URLSearchParams(url.hash.slice(1)).get('token'),
    }),
  });

  expect(response.status).toBe(204);

  return {
    origin: url.origin,
    cookie: response.headers.get('set-cookie')!.split(';')[0]!,
  };
}

async function waitForSnapshot(
  origin: string,
  cookie: string,
  accepts: (snapshot: SnapshotEvent) => boolean,
) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/dev/snapshot`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as SnapshotEvent;

    if (accepts(snapshot)) return snapshot;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for the development snapshot');
}

it('embeds the service without signal handlers and preserves its session across failed and accepted reloads', async () => {
  const app = await project();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const listeners = signals.map((signal) => process.listenerCount(signal));
  const events: DevServiceEvent[] = [];
  const dev = await startDev({
    cwd: app.cwd,
    port: 0,
    env: {},
    onEvent: (event) => events.push(event),
  });

  cleanups.push(() => dev.close());
  expect(dev.kind).toBe('started');
  expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
    listeners,
  );
  const { origin, cookie } = await session(dev);
  const first = await waitForSnapshot(
    origin,
    cookie,
    (s) => s.runtime?.state === 'running',
  );

  const reused = await startDev({ cwd: app.cwd, env: {} });

  expect(reused).toMatchObject({
    kind: 'existing',
    inspectorUrl: dev.inspectorUrl,
  });
  await reused.close();

  await writeFile(app.config, 'export default !!!');
  const failed = await waitForSnapshot(
    origin,
    cookie,
    (s) => s.failure !== null,
  );

  expect(failed.instanceId).toBe(first.instanceId);
  expect(failed.model).toEqual(first.model);

  await writeFile(
    app.config,
    app.source.replace("label: 'Note'", "label: 'Updated note'"),
  );
  const updated = await waitForSnapshot(
    origin,
    cookie,
    (s) =>
      s.model?.generation === 2 &&
      s.runtime?.state === 'running' &&
      s.runtime.generation === 2,
  );

  expect(updated.instanceId).toBe(first.instanceId);
  expect(updated.failure).toBeNull();
  expect(updated.runtime?.runtimeId).not.toBe(first.runtime?.runtimeId);
  const run = await fetch(`${origin}/dev/playground/runs`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'alice', code: 'return 42;' }),
  });

  expect(run.status).toBe(200);
  expect(await run.json()).toMatchObject({ status: 'succeeded', result: 42 });
  expect(events.filter((event) => event.type === 'listening')).toHaveLength(1);

  await Promise.all([dev.close(), dev.close()]);
  await expect(readFile(lockPath(app.cwd))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(fetch(`${origin}/dev/instance`)).rejects.toThrow();
});

it('releases the listener and project lock when startup fails after binding', async () => {
  const app = await project();

  await expect(
    startDev({
      cwd: app.cwd,
      port: 0,
      env: {},
      inspector: createInspectorApp({
        assetsDirectory: join(app.cwd, 'missing-assets'),
      }),
    }),
  ).rejects.toThrow('Inspector assets are missing');
  await expect(readFile(lockPath(app.cwd))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const dev = await startDev({
    cwd: app.cwd,
    port: 0,
    env: {},
    runtime: false,
  });

  cleanups.push(() => dev.close());
  expect(dev.kind).toBe('started');
  await dev.close({ immediate: true });
});
