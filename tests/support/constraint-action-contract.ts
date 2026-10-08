import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
  referenceInput,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import type { ObservationStore } from '@relate/runtime/storage';

const access = defineAccess({
  roles: ['editor'],
  fieldGroups: ['ordinary'],
  claims: {},
});
const Score = defineObject({
  id: 'score',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'score.id' }),
    value: native(z.number().min(0).max(100), { id: 'score.value' }),
    confidence: native(z.number().gt(0).lt(1).optional().nullable(), {
      id: 'score.confidence',
    }),
  },
});
const RecordScore = defineAction({
  id: 'record-score',
  input: z.object({
    value: z.number().min(0).max(100),
    confidence: z.number().gt(0).lt(1).optional().nullable(),
  }),
  output: z.object({ id: referenceInput(Score) }),
  creates: [Score],
  policy: { execute: access.role('editor') },
});
const graph = defineGraph({
  id: 'scores',
  objects: { Score },
  actions: { record: RecordScore },
  access,
  policies: {
    Score: {
      read: { gate: access.role('editor') },
      create: { gate: access.role('editor') },
    },
  },
});

export function constraintActionContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  it(`${name}: enforces inclusive and exclusive bounds on both input and native writes`, async () => {
    const backing = await open();
    const graphId = randomUUID();
    const scope = {
      graphId,
      definitionRevision: compile(graph).definitionRevision,
    };
    let replacement: z.input<typeof RecordScore.input> | undefined;
    let calls = 0;
    const app = createRuntime({
      graph,
      graphId,
      store: backing.store,
      connections: [],
      actionImplementations: [
        implementAction(graph, RecordScore, async ({ input, objects }) => {
          calls++;
          const values = replacement ?? input;

          return objects.Score.create({
            value: values.value,
            confidence: values.confidence,
          });
        }),
      ],
    });
    const actor = app.as({ id: 'editor', roles: ['editor'], claims: {} });

    try {
      for (const input of [
        { value: -1 },
        { value: 101 },
        { value: 50, confidence: 0 },
        { value: 50, confidence: 1 },
      ]) {
        const before = calls;
        const idempotencyKey = randomUUID();

        await expect(
          actor.actions.record({ input, idempotencyKey }),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(calls).toBe(before);
        replacement = input;
        await expect(
          actor.actions.record({
            input: { value: 50, confidence: 0.5 },
            idempotencyKey,
          }),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect(calls).toBe(before + 1);
        expect(
          await backing.store.native!.loadInvocation(
            scope,
            RecordScore.id,
            idempotencyKey,
          ),
        ).toBeUndefined();
        replacement = undefined;
      }

      for (const input of [
        { value: 0 },
        { value: 100, confidence: null },
        { value: 50.5, confidence: 0.5 },
      ]) {
        const receipt = await actor.actions.record({
          input,
          idempotencyKey: randomUUID(),
        });

        expect(await actor.objects.Score.get(receipt.output.id)).toMatchObject({
          status: 'ok',
          data: input,
        });
      }
    } finally {
      await app.close();
      await backing.close();
    }
  });
}
