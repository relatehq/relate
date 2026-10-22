import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineApp,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
  referenceInput,
} from 'relate';

const access = defineAccess({
  roles: ['member'],
  fieldGroups: ['ordinary'],
  claims: {},
});

const Todo = defineObject({
  id: 'notes.todo',
  label: 'Todo',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'notes.todo.id' }),
    title: native(z.string().min(1).max(200), { id: 'notes.todo.title' }),
    note: native(z.string().max(4000), { id: 'notes.todo.note' }),
    owner: native(z.string(), { id: 'notes.todo.owner' }),
  },
});

const AddTodo = defineAction({
  id: 'notes.add-todo',
  input: z.object({
    title: z.string().min(1).max(200),
    note: z.string().max(4000),
  }),
  output: z.object({ todoId: referenceInput(Todo) }),
  creates: [Todo],
  policy: { execute: access.role('member') },
});

const ownedByMember = {
  gate: access.role('member'),
  where: { owner: { eq: access.actor.id } },
  evidenceMaxAgeMs: 30_000,
};

export const graph = defineGraph({
  id: 'todo-notes',
  principals: { ada: { roles: ['member'], claims: {} } },
  objects: { Todo },
  actions: { addTodo: AddTodo },
  access,
  policies: { Todo: { read: ownedByMember, create: ownedByMember } },
});

const addTodo = implementAction(
  graph,
  AddTodo,
  async ({ actor, input, objects }) => {
    // Ownership comes from the authenticated actor, never from user input.
    const todo = await objects.Todo.create({ ...input, owner: actor.id });

    return { todoId: todo.id };
  },
);

export const app = defineApp({
  graph,
  setup: () => ({ bindings: [], actionImplementations: [addTodo] }),
});
