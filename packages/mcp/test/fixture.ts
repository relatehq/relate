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
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';

/** Fresh real model/runtime owned by each test; never imports the tutorial. */
export async function createFixture(
  cleanup: (close: () => Promise<void>) => void,
) {
  const access = defineAccess({
    roles: ['writer'],
    claims: {},
    fieldGroups: ['ordinary'],
  });
  const Note = defineObject({
    id: 'test.note',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'note.id' }),
      text: native(z.string(), { id: 'note.text' }),
    },
  });
  const AddNote = defineAction({
    id: 'test.add-note',
    input: z.object({ text: z.string() }),
    output: z.object({ id: z.string() }),
    creates: [Note],
    policy: { execute: access.role('writer') },
  });
  const graph = defineGraph({
    id: 'mcp-test',
    objects: { Note },
    actions: { addNote: AddNote },
    access,
    policies: {
      Note: {
        read: { gate: access.role('writer') },
        create: { gate: access.role('writer') },
      },
    },
  });
  const runtime = createRuntime({
    graph,
    graphId: 'test',
    bindings: [],
    actionImplementations: [
      implementAction(graph, AddNote, async ({ input, objects }) => {
        const note = await objects.Note.create({ text: input.text });

        return { id: note.id };
      }),
    ],
  });

  cleanup(() => runtime.close());
  const actor = { id: 'writer', roles: ['writer'], claims: {} };
  const first = await runtime
    .as(actor)
    .actions.addNote({ input: { text: 'first' }, idempotencyKey: 'seed' });

  return {
    binding: {
      description: compile(graph).consumer,
      operations: runtime.operations(actor),
    },
    hidden: {
      description: compile(graph).consumer,
      operations: runtime.operations({ id: 'outsider', roles: [], claims: {} }),
    },
    first,
  };
}
