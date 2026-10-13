import { startApp } from '@relate/node';
import { assertFields } from 'relate';
import { app } from './app.js';

const relate = await startApp(app);

try {
  // A real host authenticates the user before supplying this principal.
  const { actions, objects } = relate.as({
    id: 'ada',
    roles: ['member'],
    claims: {},
  });
  const receipt = await actions.addTodo({
    input: { title: 'Try Relate', note: 'Create a todo, then read my notes.' },
    idempotencyKey: 'first-todo',
  });
  const todo = await objects.Todo.get(receipt.output.todoId, {
    select: ['title', 'note'],
  });

  assertFields(todo, ['title', 'note']);

  const todos = [];

  // Iteration follows every page and applies the owner's read policy.
  for await (const result of objects.Todo.query({
    select: ['title', 'note'],
  })) {
    todos.push(result.data);
  }

  console.log(JSON.stringify(todos, null, 2));
} finally {
  await relate.close();
}
