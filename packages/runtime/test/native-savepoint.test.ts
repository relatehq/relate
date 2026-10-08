import { expect, it } from 'vitest';
import type { NativeInvocation } from '@relate/runtime/storage';
import { createNativeMemoryStore } from '../src/native-memory.js';

it('undoes nested savepoint writes and restores claims without losing outer work', async () => {
  const store = createNativeMemoryStore(() => true);
  const scope = { graphId: 'graph', definitionRevision: 'revision' };
  const record = (objectId: string) => ({
    objectDefinitionId: 'Review',
    objectId,
    values: {},
    createdAt: 0,
  });
  const invocation = (key: string): NativeInvocation => ({
    actionDefinitionId: 'review',
    idempotencyKey: key,
    actorId: 'ana',
    reads: [],
    input: {},
    receipt: { invocationId: key, state: 'succeeded', output: {} },
  });

  await store.transaction(scope, async (tx) => {
    await tx.insert(record('retained'));
    await tx.claim('review', 'outer');
    await expect(
      tx.savepoint(async () => {
        await tx.insert(record('discarded'));
        await tx.saveInvocation(invocation('outer'));
        await tx.savepoint(async () => {
          await tx.claim('review', 'inner');
          await tx.saveInvocation(invocation('inner'));
          await tx.insert(record('nested'));
        });
        throw new Error('rollback outer');
      }),
    ).rejects.toThrow('rollback outer');
    expect(await tx.load('Review', 'retained')).toBeDefined();
    expect(await tx.load('Review', 'discarded')).toBeUndefined();
    expect(await tx.load('Review', 'nested')).toBeUndefined();
    expect(await tx.findInvocation('review', 'outer')).toBeUndefined();
    expect(await tx.findInvocation('review', 'inner')).toBeUndefined();
    await tx.saveInvocation(invocation('outer'));
    // The nested claim was rolled back as well, so the key can be claimed again.
    await tx.claim('review', 'inner');
    await tx.saveInvocation(invocation('inner'));
    await tx.savepoint(async () => {
      await tx.insert(record('committed'));
      await expect(
        tx.savepoint(async () => {
          await tx.insert(record('inner-discarded'));
          throw new Error('rollback inner');
        }),
      ).rejects.toThrow('rollback inner');
    });
  });
  expect(await store.load(scope, 'Review', 'retained')).toBeDefined();
  expect(await store.load(scope, 'Review', 'committed')).toBeDefined();
  expect(await store.load(scope, 'Review', 'inner-discarded')).toBeUndefined();
  expect(await store.loadInvocation(scope, 'review', 'outer')).toEqual(
    invocation('outer'),
  );
  expect(await store.loadInvocation(scope, 'review', 'inner')).toEqual(
    invocation('inner'),
  );
});
