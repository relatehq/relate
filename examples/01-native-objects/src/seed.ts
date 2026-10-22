import type { Relate } from '@relate/node';
import { graph } from './app.js';

export async function seed(relate: Relate<typeof graph>) {
  await relate.as({ id: 'ada', ...graph.principals.ada }).actions.addTodo({
    input: { title: 'Try Relate', note: 'Create a todo, then read my notes.' },
    idempotencyKey: 'first-todo',
  });
}
