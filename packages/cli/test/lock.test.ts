import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acquireLock, lockPath } from '@relate/cli';
import type { Lock, LockMetadata } from '@relate/cli';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'relate-lock-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const acquire = (options: Partial<Parameters<typeof acquireLock>[0]> = {}) =>
  acquireLock({
    projectRoot: root,
    configPath: join(root, 'relate.config.ts'),
    instanceId: 'instance',
    verifyOwner: async () => true,
    waitForUrlMs: 50,
    ...options,
  });

it('acquires exclusively, records owner metadata and releases only its own lock', async () => {
  const first = await acquire();

  expect(first.kind).toBe('acquired');
  const lock = (first as { lock: Lock }).lock;
  const stored = JSON.parse(
    await readFile(lockPath(root), 'utf8'),
  ) as LockMetadata;

  expect(stored).toMatchObject({
    version: 1,
    pid: process.pid,
    instanceId: 'instance',
    state: 'starting',
    url: null,
  });
  expect(stored.ownerId.length).toBeGreaterThanOrEqual(16);

  await lock.update({ state: 'listening', url: 'http://127.0.0.1:4318' });
  expect(JSON.parse(await readFile(lockPath(root), 'utf8'))).toMatchObject({
    state: 'listening',
    url: 'http://127.0.0.1:4318',
  });

  // A verified live owner is reported, never replaced.
  const second = await acquire();

  expect(second.kind).toBe('held');
  expect((second as { metadata: LockMetadata }).metadata.ownerId).toBe(
    stored.ownerId,
  );

  // Another owner's metadata survives this lock's release.
  await writeFile(
    lockPath(root),
    JSON.stringify({ ...stored, ownerId: 'someone-else-entirely-0000' }),
  );
  await lock.release();
  expect(JSON.parse(await readFile(lockPath(root), 'utf8')).ownerId).toBe(
    'someone-else-entirely-0000',
  );
});

it('waits for a starting owner and reports it when no URL appears', async () => {
  const first = await acquire();
  const result = await acquire();

  expect(result.kind).toBe('unverifiable');
  expect((result as { reason: string }).reason).toMatch(/already starting/);
  await (first as { lock: Lock }).lock.release();
});

it('refuses an alive owner that does not identify itself', async () => {
  const first = await acquire();

  await (first as { lock: Lock }).lock.update({
    state: 'listening',
    url: 'http://127.0.0.1:1',
  });
  const result = await acquire({ verifyOwner: async () => false });

  expect(result.kind).toBe('unverifiable');
  expect((result as { reason: string }).reason).toMatch(/did not identify/);
  expect((result as { path: string }).path).toBe(lockPath(root));
  await (first as { lock: Lock }).lock.release();
});

it('reclaims a lock whose owner PID is demonstrably gone, exclusively', async () => {
  const first = await acquire();
  const metadata = (first as { lock: Lock }).lock.metadata;

  // Simulate a crashed owner: an impossible PID that nothing can reuse now.
  await writeFile(
    lockPath(root),
    JSON.stringify({ ...metadata, pid: 2_147_483_646, processStartedAt: null }),
  );
  const [a, b] = await Promise.all([acquire(), acquire()]);
  const kinds = [a.kind, b.kind].sort();

  expect(kinds[0]).toBe('acquired');
  expect(['held', 'unverifiable', 'acquired']).toContain(kinds[1]);
  expect(kinds.filter((kind) => kind === 'acquired').length).toBe(1);

  for (const result of [a, b])
    if (result.kind === 'acquired') await result.lock.release();
});

it('reports corrupt lock files instead of overwriting them', async () => {
  await writeFile(lockPath(root), 'not json').catch(async () => {
    const first = await acquire();

    await (first as { lock: Lock }).lock.release();
    await writeFile(lockPath(root), 'not json');
  });
  const result = await acquire();

  expect(result.kind).toBe('unverifiable');
  expect((result as { reason: string }).reason).toMatch(/not readable/);
  expect(await readFile(lockPath(root), 'utf8')).toBe('not json');
});
