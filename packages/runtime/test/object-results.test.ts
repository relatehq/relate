import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  nativeMembership,
  objectId,
  native,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';

it('returns resolved identity through transaction and ordinary reads without selecting the ID field', async () => {
  const access = defineAccess({
    roles: ['reader'],
    claims: {},
    fieldGroups: ['ordinary'],
  });
  const Note = defineObject({
    id: 'note',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'note.id' }),
      text: native(z.string(), { id: 'note.text' }),
    },
  });
  const Add = defineAction({
    id: 'add',
    input: z.object({}),
    output: z.object({ id: z.string() }),
    creates: [Note],
    policy: { execute: access.role('reader') },
  });
  const graph = defineGraph({
    id: 'notes',
    objects: { Note },
    actions: { add: Add },
    access,
    policies: {
      Note: {
        read: { gate: access.role('reader') },
        create: { gate: access.role('reader') },
      },
    },
  });
  const actor = { id: 'reader', roles: ['reader'], claims: {} };
  const model = compile(graph);
  const runtime = createRuntime({
    model,
    graphId: 'notes',
    sources: {},
    actionHandlers: {
      add: async (context) => {
        const created = await context.create('note', { text: 'hello' });
        const read = await context.read('note', created.id, {
          select: ['text'],
        });

        expect(read).toMatchObject({
          status: 'ok',
          id: created.id,
          data: { text: 'hello' },
        });

        if (read.status !== 'ok')
          throw new Error('Created record was not readable');

        expect(read.data).not.toHaveProperty('id');

        return { id: read.id };
      },
    },
  });
  const receipt = await runtime.invoke(actor, 'add', {
    input: {},
    idempotencyKey: 'one',
  });

  if (receipt.state !== 'succeeded') throw new Error('Action failed');

  const output = Add.output.parse(receipt.output);
  const read = await runtime.read(actor, 'note', output.id, {
    select: ['text'],
  });

  expect(read).toMatchObject({
    status: 'ok',
    id: output.id,
    data: { text: 'hello' },
  });
  await expect(runtime.read(actor, 'note', 'missing')).resolves.toEqual({
    status: 'not-found',
  });
});
