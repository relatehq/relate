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

it('reclaims a dead owner without admitting concurrent owners', async () => {
  // Exercise repeated contention: the old rename-based reclaim can remove a
  // newly acquired lock after multiple callers have read the dead owner.
  for (let round = 0; round < 12; round += 1) {
    const first = await acquire();

    expect(first.kind).toBe('acquired');
    const metadata = (first as { lock: Lock }).lock.metadata;

    await writeFile(
      lockPath(root),
      JSON.stringify({
        ...metadata,
        pid: 2_147_483_646,
        processStartedAt: null,
      }),
    );
    const results = await Promise.all(
      Array.from({ length: 16 }, () => acquire({ waitForUrlMs: 0 })),
    );
    const winners = results.filter((result) => result.kind === 'acquired');

    expect(winners).toHaveLength(1);
    expect(JSON.parse(await readFile(lockPath(root), 'utf8')).ownerId).toBe(
      winners[0]!.lock.metadata.ownerId,
    );
    await winners[0]!.lock.release();
  }
});

it('fails closed when a reclamation guard already exists', async () => {
  const first = await acquire();
  const metadata = (first as { lock: Lock }).lock.metadata;
  const stale = { ...metadata, pid: 2_147_483_646, processStartedAt: null };

  await writeFile(lockPath(root), JSON.stringify(stale));
  await writeFile(`${lockPath(root)}.reclaim`, '');
  const result = await acquire();

  expect(result).toMatchObject({
    kind: 'unverifiable',
    reason: expect.stringContaining(`${lockPath(root)}.reclaim`),
  });
  expect(JSON.parse(await readFile(lockPath(root), 'utf8'))).toEqual(stale);
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

it('retries acquisition when a starting owner releases its lock', async () => {
  const first = await acquire();

  expect(first.kind).toBe('acquired');
  const lock = (first as { lock: Lock }).lock;
  const pending = acquire({ waitForUrlMs: 1000 });

  await new Promise((resolve) => setTimeout(resolve, 150));
  await lock.release();
  const next = await pending;

  expect(next.kind).toBe('acquired');

  if (next.kind === 'acquired') await next.lock.release();
});

it('never exposes partially written metadata during concurrent acquisition', async () => {
  const configPath = join(root, 'x'.repeat(1_000_000));
  const results = await Promise.all(
    Array.from({ length: 12 }, () => acquire({ configPath, waitForUrlMs: 0 })),
  );

  expect(results.filter((result) => result.kind === 'acquired')).toHaveLength(
    1,
  );

  for (const result of results) {
    if (result.kind === 'unverifiable') expect(result.metadata).not.toBeNull();

    if (result.kind === 'acquired') await result.lock.release();
  }
});
