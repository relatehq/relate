import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OrderingConflict, RetentionError } from '@relate/runtime/storage';
import type {
  Observation,
  ObservationStore,
  StorageScope,
} from '@relate/runtime/storage';

/** The same behavioral checks run against each adapter. */
export function storeContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close: () => Promise<void> }>,
) {
  describe(name, () => {
    let fixture: Awaited<ReturnType<typeof open>>;
    let store: ObservationStore;
    let scope: StorageScope;
    const observation = (token: string, name = 'Ada'): Observation => ({
      state: 'present',
      raw: { id: 'external-1', name },
      values: { 'person.name': name },
      observedAt: 1_000,
      token,
    });
    const adopt = (incoming: Observation) =>
      store.accept(scope, {
        sourceRecordId: 'external-1',
        adopt: true,
        observation: incoming,
      });

    beforeEach(async () => {
      fixture = await open();
      store = fixture.store;
      scope = {
        graphId: randomUUID(),
        definitionRevision: 'revision-1',
        objectDefinitionId: 'person',
        sourceDefinitionId: 'people',
        connectionId: 'connection-1',
        providerAccountId: 'account-1',
        partition: 'shared-service',
      };
      await store.install(scope.graphId, scope.definitionRevision);
    });
    afterEach(async () => {
      await fixture?.close();
    });

    it('isolates application-owned identity from verified accounts and other connections', async () => {
      const verified = await adopt(observation(await store.beginFetch()));
      const application = { ...scope, providerAccountId: null };

      expect(
        await store.load(application, verified.object.objectId),
      ).toBeUndefined();
      expect(await store.resolve(application, 'external-1')).toBeUndefined();
      expect(await store.scan(application, { limit: 10 })).toEqual({
        objects: [],
        hasMore: false,
      });
      const saved = await Promise.all(
        Array.from({ length: 5 }, async () =>
          store.accept(application, {
            sourceRecordId: 'external-1',
            adopt: true,
            observation: observation(await store.beginFetch()),
          }),
        ),
      );
      const first = saved[0]!.object;

      expect(new Set(saved.map(({ object }) => object.objectId)).size).toBe(1);
      expect(first.objectId).not.toBe(verified.object.objectId);
      expect(await store.load(scope, first.objectId)).toBeUndefined();
      expect(await store.load(application, first.objectId)).toEqual(
        await store.resolve(application, 'external-1'),
      );
      expect(
        (await store.scan(application, { limit: 10 })).objects.map(
          (object) => object.objectId,
        ),
      ).toEqual([first.objectId]);
      expect(
        await store.resolve(
          { ...application, connectionId: 'another' },
          'external-1',
        ),
      ).toBeUndefined();
      expect(await store.resolve(scope, 'external-1')).toEqual(verified.object);
    });

    it('pins revisions and isolates scope', async () => {
      await store.install(scope.graphId, scope.definitionRevision);
      await expect(
        store.install(scope.graphId, 'revision-2'),
      ).rejects.toThrow();
      const { object } = await adopt(observation(await store.beginFetch()));

      for (const field of [
        'graphId',
        'definitionRevision',
        'objectDefinitionId',
        'sourceDefinitionId',
        'connectionId',
        'providerAccountId',
      ] as const) {
        expect(
          await store.load({ ...scope, [field]: 'other' }, object.objectId),
        ).toBeUndefined();
      }

      await expect(
        store.accept(
          { ...scope, definitionRevision: 'revision-2' },
          {
            sourceRecordId: 'external-1',
            adopt: true,
            observation: observation(await store.beginFetch()),
          },
        ),
      ).rejects.toBeInstanceOf(RetentionError);
    });

    it('resolves only existing scoped identities without adoption and returns isolated snapshots', async () => {
      expect(await store.resolve(scope, 'external-1')).toBeUndefined();
      const { object } = await adopt(observation(await store.beginFetch()));

      expect(await store.resolve(scope, 'external-1')).toEqual(object);

      for (const field of [
        'graphId',
        'definitionRevision',
        'objectDefinitionId',
        'sourceDefinitionId',
        'connectionId',
        'providerAccountId',
        'partition',
      ] as const) {
        expect(
          await store.resolve({ ...scope, [field]: 'other' }, 'external-1'),
        ).toBeUndefined();
      }

      const resolved = (await store.resolve(scope, 'external-1'))!;

      resolved.observation.values['person.name'] = 'changed';
      expect(await store.resolve(scope, 'external-1')).toEqual(object);
      expect(await store.resolve(scope, object.objectId)).toBeUndefined();
    });

    it('scans only adopted scoped identities with stable bounded continuations', async () => {
      const saved = await Promise.all(
        ['one', 'two', 'three'].map(async (sourceRecordId) =>
          store.accept(scope, {
            sourceRecordId,
            adopt: true,
            observation: observation(await store.beginFetch()),
          }),
        ),
      );
      const expected = saved.map((r) => r.object.objectId).sort();
      const first = await store.scan(scope, { limit: 2 });

      expect(first.objects.map((o) => o.objectId)).toEqual(
        expected.slice(0, 2),
      );
      expect(first.hasMore).toBe(true);
      const last = await store.scan(scope, {
        limit: 2,
        after: first.objects[1]!.objectId,
      });

      expect(last.objects.map((o) => o.objectId)).toEqual(expected.slice(2));
      expect(last.hasMore).toBe(false);
      first.objects[0]!.observation.values['person.name'] = 'mutation';
      expect(
        (await store.load(scope, expected[0]!))?.observation.values[
          'person.name'
        ],
      ).toBe('Ada');

      for (const field of [
        'graphId',
        'definitionRevision',
        'objectDefinitionId',
        'sourceDefinitionId',
        'connectionId',
        'providerAccountId',
        'partition',
      ] as const) {
        expect(
          await store.scan({ ...scope, [field]: 'other' }, { limit: 2 }),
        ).toEqual({ objects: [], hasMore: false });
      }

      for (const limit of [0, 101, 1.5])
        await expect(store.scan(scope, { limit })).rejects.toThrow();
    });

    it('allocates ordered tokens and one identity for concurrent adoptions', async () => {
      const tokens = await Promise.all(
        Array.from({ length: 10 }, () => store.beginFetch()),
      );

      expect(new Set(tokens).size).toBe(10);
      expect(BigInt(await store.beginFetch())).toBeGreaterThan(
        tokens.map(BigInt).reduce((a, b) => (a > b ? a : b)),
      );
      const results = await Promise.all(
        tokens.map((token) => adopt(observation(token))),
      );

      expect(new Set(results.map((r) => r.object.objectId)).size).toBe(1);
      expect(results[0]!.object.objectId).not.toBe('external-1');
    });

    it('requires adoption and preserves identity through deletion', async () => {
      const first = observation(await store.beginFetch());

      await expect(
        store.accept(scope, {
          sourceRecordId: 'external-1',
          adopt: false,
          observation: first,
        }),
      ).rejects.toBeInstanceOf(RetentionError);
      const { object } = await adopt(first);

      await expect(
        store.accept(scope, {
          sourceRecordId: 'external-1',
          objectId: 'wrong',
          adopt: false,
          observation: first,
        }),
      ).rejects.toBeInstanceOf(RetentionError);
      const deleted = await store.accept(scope, {
        sourceRecordId: 'external-1',
        objectId: object.objectId,
        adopt: false,
        observation: {
          ...first,
          token: await store.beginFetch(),
          state: 'deleted',
          raw: {},
          values: {},
        },
      });

      expect(deleted.object.objectId).toBe(object.objectId);
      expect(
        (await store.load(scope, object.objectId))?.observation.state,
      ).toBe('deleted');
    });

    it('retains winners, advances unchanged evidence and rejects conflicts atomically', async () => {
      const old = observation(await store.beginFetch());
      const newer = observation(await store.beginFetch(), 'Grace');
      const winner = await adopt(newer);

      expect((await adopt(old)).acceptance).toBe('superseded');
      expect((await adopt(newer)).acceptance).toBe('replay');
      await expect(
        adopt({ ...newer, values: { 'person.name': 'conflict' } }),
      ).rejects.toBeInstanceOf(OrderingConflict);
      expect(await store.load(scope, winner.object.objectId)).toEqual(
        winner.object,
      );
      const refreshed = {
        ...newer,
        token: await store.beginFetch(),
        observedAt: 2_000,
      };

      expect((await adopt(refreshed)).acceptance).toBe('unchanged');
      expect(
        (await store.load(scope, winner.object.objectId))?.observation,
      ).toEqual(refreshed);
    });

    it('uses source versions before fetch ordering', async () => {
      const oldToken = await store.beginFetch();
      const newToken = await store.beginFetch();
      const winner = await adopt({
        ...observation(oldToken, 'Grace'),
        version: { domain: 'v1', value: '2' },
      });

      expect(
        (
          await adopt({
            ...observation(newToken),
            version: { domain: 'v1', value: '1' },
          })
        ).acceptance,
      ).toBe('superseded');
      await expect(
        adopt({
          ...observation(await store.beginFetch()),
          version: { domain: 'v2', value: '3' },
        }),
      ).rejects.toBeInstanceOf(OrderingConflict);
      expect(await store.load(scope, winner.object.objectId)).toEqual(
        winner.object,
      );
    });

    it('isolates inputs and returned snapshots from retained state', async () => {
      const incoming = observation(await store.beginFetch());
      const { object } = await adopt(incoming);
      const expected = structuredClone(object);

      incoming.raw.name = 'input mutation';
      object.observation.values['person.name'] = 'result mutation';
      const loaded = (await store.load(scope, object.objectId))!;

      loaded.observation.raw.name = 'load mutation';
      expect(await store.load(scope, object.objectId)).toEqual(expected);
    });
  });
}
