import { expect, it } from 'vitest';
import { createMemoryStore } from '@relate/runtime';
import {
  activityStoreContract,
  feedDraft,
  operationDraft,
} from '../../../tests/support/activity-store-contract.js';
import {
  createActivityCapture,
  newOperationScope,
} from '../src/activity/index.js';
import type { ActivityDiagnostic } from 'relate/storage';

activityStoreContract('memory activity', async () => ({
  store: createMemoryStore(),
  close: async () => {},
}));

it('expires evicted feed checkpoints and preserves object provenance', async () => {
  const store = createMemoryStore({ maxEntries: 2 });

  await store.install('g', 'v1');
  const scope = { graphId: 'g', definitionRevision: 'v1' };
  const cursor = (await store.activity!.feed.read('g')).nextCursor;

  for (let i = 0; i < 3; i++)
    await store.native!.transaction(scope, async (tx) => {
      await tx.appendFeed!([feedDraft('g')]);
    });

  await expect(
    store.activity!.feed.read('g', { cursor }),
  ).rejects.toMatchObject({ code: 'cursor-expired' });
  expect((await store.activity!.feed.read('g')).entries).toHaveLength(2);
});
it('bounds queue resources while one append hangs and abandons within the flush deadline', async () => {
  const store = createMemoryStore(),
    diagnostics: ActivityDiagnostic[] = [];
  let writes = 0;
  const capture = createActivityCapture(
    'g',
    'v1',
    {
      ...store.activity!,
      appendOperations: () => {
        writes++;

        return new Promise(() => {});
      },
    },
    {
      maxEntries: 2,
      batchEntries: 1,
      flushTimeoutMs: 10,
      onError: (d) => diagnostics.push(d),
    },
  );

  capture.enqueue(operationDraft('g'));
  await Promise.resolve();
  await Promise.resolve();
  capture.enqueue(operationDraft('g'));
  capture.enqueue(operationDraft('g'));
  await capture.flush();
  expect(writes).toBe(1);
  expect(capture.counters.dropped).toBe(3);
  expect(diagnostics.map((d) => d.code)).toEqual(['overflow', 'shutdown']);
  expect(JSON.stringify(diagnostics)).not.toContain('customer');
});
it('isolates synchronous append and diagnostic failures, then continues without retry', async () => {
  const store = createMemoryStore();

  await store.install('g', 'v1');
  let writes = 0;
  const capture = createActivityCapture(
    'g',
    'v1',
    {
      ...store.activity!,
      appendOperations: (g, rows) => {
        if (++writes === 1) throw new Error('SECRET');

        return store.activity!.appendOperations(g, rows);
      },
    },
    {
      onError: () => {
        throw new Error('hook');
      },
    },
  );
  const run = () =>
    capture.run(
      newOperationScope({ kind: 'principal', id: 'ana' }),
      'query',
      'customer',
      async () => 42,
      () => ({ outcome: { status: 'ok' }, details: { hasMore: false } }),
    );

  expect(await run()).toBe(42);
  await capture.flush();
  expect(await run()).toBe(42);
  await capture.flush();
  expect(writes).toBe(2);
  expect((await store.activity!.operations.list('g')).entries).toHaveLength(1);
});

import { activityPage, activityId } from '@relate/runtime/storage';

it('pins operation browsing without hiding late rows below the descending cursor', () => {
  const snapshot = { streamId: activityId(), position: '0', floor: '0' };
  const row = (second: number) => ({
    ...operationDraft('g'),
    recordedAt: new Date(1000 * second).toISOString(),
  });
  const oldest = row(1),
    middle = row(2),
    newest = row(3),
    above = row(4),
    late = row(2.5);
  const first = activityPage(
    'g',
    'operations',
    snapshot,
    [oldest, middle, newest],
    { limit: 1 },
  );
  const second = activityPage(
    'g',
    'operations',
    snapshot,
    [oldest, middle, newest, above, late],
    { cursor: first.nextCursor, limit: 1 },
  );

  expect(second.entries.map((e) => e.id)).toEqual([late.id]);
  const passed = row(2.8);
  const third = activityPage(
    'g',
    'operations',
    snapshot,
    [oldest, middle, newest, above, late, passed],
    { cursor: second.nextCursor },
  );

  expect(third.entries.map((e) => e.id)).toEqual([middle.id, oldest.id]);
  expect(
    activityPage('g', 'operations', snapshot, [
      oldest,
      middle,
      newest,
      above,
      late,
      passed,
    ]).entries.map((e) => e.id),
  ).toContain(passed.id);
});
it('rejects malformed options, unknown metadata and byte-overflow batches', async () => {
  const store = createMemoryStore({ batchBytes: 1500 });

  await store.install('g', 'v1');
  await expect(
    store.activity!.feed.read('g', { cursor: 123 } as never),
  ).rejects.toMatchObject({ code: 'invalid-cursor' });
  await expect(
    store.activity!.feed.read('g', [] as never),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  await expect(
    store.activity!.operations.list('g', {
      filter: { object: { objectDefinitionId: 'customer', objectId: 123 } },
    } as never),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  await expect(
    store.activity!.appendOperations('g', [
      {
        ...operationDraft('g'),
        context: { requestId: 'r', transport: 'embedded', secret: 'value' },
      } as never,
    ]),
  ).rejects.toThrow();
  await expect(
    store.native!.transaction(
      { graphId: 'g', definitionRevision: 'v1' },
      async (tx) => {
        await tx.appendFeed!([
          {
            ...feedDraft('g'),
            changedPropertyIds: ['x'.repeat(1600)],
          } as import('relate/storage').FeedDraft,
        ]);
      },
    ),
  ).rejects.toThrow();
  expect((await store.activity!.feed.read('g')).entries).toEqual([]);
});
it('marks truncated lineage and retains provenance after all creation history is evicted', async () => {
  const store = createMemoryStore({ maxEntries: 1 });

  await store.install('g', 'v1');
  const draft = feedDraft('g'),
    scope = { graphId: 'g', definitionRevision: 'v1' },
    provenance = {
      kind: 'created' as const,
      actor: { kind: 'principal' as const, id: 'ana' },
      at: new Date().toISOString(),
      invocationId: draft.invocationId!,
    };

  await store.native!.transaction(scope, async (tx) => {
    await tx.insert({
      objectDefinitionId: 'review',
      objectId: 'one',
      values: {},
      createdAt: Date.now(),
      provenance,
    });
    await tx.appendFeed!([draft]);
  });
  await store.native!.transaction(scope, async (tx) => {
    await tx.appendFeed!([feedDraft('g')]);
  });
  expect(
    await store.native!.provenance(scope, {
      objectDefinitionId: 'review',
      objectId: 'one',
    }),
  ).toEqual(provenance);
  const capture = createActivityCapture('g', 'v1', store.activity, {
    maxObjects: 1,
  });

  capture.enqueue(operationDraft('g'));
  await capture.flush();
  const operation = (await store.activity!.operations.list('g')).entries[0]!;

  expect(operation.objects).toHaveLength(1);
  expect(operation.details.truncated).toEqual({ omittedObjects: 1 });
});
