import { it, expect } from 'vitest';
import { createMemoryStore } from '@relate/runtime';
import { AdoptionConflict } from '@relate/runtime/storage';
import type { StorageScope, Observation } from '@relate/runtime/storage';
import {
  testAttribution,
  testCreation,
} from '../../../tests/support/activity.js';

for (const failure of ['host-race', 'second-accept', 'feed'] as const) {
  it(`rolls back all prepared memory changes on ${failure}`, async () => {
    const store = createMemoryStore();
    const scope: StorageScope = {
      graphId: 'g',
      definitionRevision: 'r',
      objectDefinitionId: 'o',
      sourceDefinitionId: 's',
      connectionId: 'c',
      resourceId: 'records',
      providerAccountId: null,
      partition: 'shared-service',
    };

    await store.install('g', 'r');
    const observation: Observation = {
      state: 'present',
      raw: { name: 'A' },
      values: { name: 'A' },
      token: await store.beginFetch(),
      observedAt: 1000,
    };
    const input = {
      sourceRecordId: 'external',
      objectId: 'pending',
      adopt: true as const,
      observation,
      attribution: { ...testAttribution(), invocationId: 'invocation' },
    };

    await expect(
      store.native!.transaction(scope, async (tx) => {
        await tx.insert(
          {
            objectDefinitionId: 'native',
            objectId: 'created',
            values: {},
            createdAt: 1000,
          },
          testCreation(),
        );
        await tx.accept!(scope, input);
        expect(await store.load(scope, 'pending')).toBeUndefined();

        if (failure === 'host-race')
          await store.accept(scope, {
            sourceRecordId: 'external',
            adopt: true,
            observation,
            attribution: testAttribution(),
          });

        if (failure === 'second-accept') await tx.accept!(scope, input);

        if (failure === 'feed') await tx.appendFeed!([{} as never]);
      }),
    ).rejects.toThrow(failure === 'feed' ? Error : AdoptionConflict);
    expect(await store.load(scope, 'pending')).toBeUndefined();
    expect(
      await store.native!.load(scope, 'native', 'created'),
    ).toBeUndefined();
    expect(await store.provenance(scope, 'pending')).toBeUndefined();
  });
}

it('discards prepared source acceptance when a savepoint rolls back', async () => {
  const store = createMemoryStore();
  const scope: StorageScope = {
    graphId: 'g',
    definitionRevision: 'r',
    objectDefinitionId: 'o',
    sourceDefinitionId: 's',
    connectionId: 'c',
    resourceId: 'records',
    providerAccountId: null,
    partition: 'shared-service',
  };

  await store.install('g', 'r');
  await store.native!.transaction(scope, async (tx) => {
    await expect(
      tx.savepoint(async () => {
        await tx.accept!(scope, {
          sourceRecordId: 'external',
          objectId: 'pending',
          adopt: true,
          observation: {
            state: 'present',
            raw: {},
            values: {},
            token: await store.beginFetch(),
            observedAt: 1000,
          },
          attribution: { ...testAttribution(), invocationId: 'invocation' },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
  });
  expect(await store.resolve(scope, 'external')).toBeUndefined();
});
