import { expect, test } from 'vitest';
import { startApp } from '@relate/node';
import { app } from '../src/app.js';

test('members add and list their own notes; retries do not duplicate them', async () => {
  const relate = await startApp(app);

  try {
    const ada = relate.as({ id: 'ada', roles: ['member'], claims: {} });
    const sam = relate.as({ id: 'sam', roles: ['member'], claims: {} });
    const request = {
      input: { title: 'Buy milk', note: 'On the way home' },
      idempotencyKey: 'shopping-1',
    };
    const receipt = await ada.actions.addTodo(request);

    expect(await ada.actions.addTodo(request)).toEqual(receipt);
    const todos = [];

    for await (const todo of ada.objects.Todo.query({
      select: ['title', 'note', 'owner'],
    })) {
      todos.push(todo.data);
    }

    expect(todos).toEqual([
      { title: 'Buy milk', note: 'On the way home', owner: 'ada' },
    ]);
    expect((await ada.objects.Todo.get(receipt.output.todoId)).status).toBe(
      'ok',
    );
    expect((await sam.objects.Todo.get(receipt.output.todoId)).status).toBe(
      'not-found',
    );
    const hidden = [];

    for await (const todo of sam.objects.Todo.query()) hidden.push(todo);

    expect(hidden).toEqual([]);
    await expect(
      relate
        .as({ id: 'guest', roles: [], claims: {} })
        .actions.addTodo(request),
    ).rejects.toMatchObject({ code: 'denied' });
  } finally {
    await relate.close();
  }
});
