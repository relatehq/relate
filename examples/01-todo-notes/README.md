# 01 · Todo notes

The smallest application: add a todo with a note, read it, and list your own
todos. Relate owns the data in memory. No connector, database server, or
credentials are needed.

```sh
pnpm install
pnpm example:todo-notes
```

The command opens a seeded Inspector with Ada as the demo principal. Explore
Todo and run `addTodo`; state disappears when you stop with Ctrl+C. Use
`--no-open` to print the link without opening a browser.

For the scripted create/read/query walkthrough, run
`pnpm example:todo-notes:walkthrough`. It prints the following and exits:

```json
[{ "title": "Try Relate", "note": "Create a todo, then read my notes." }]
```

## What this teaches

- [src/app.ts](src/app.ts) defines one native `Todo` object, owner-only read and
  create policies, and an `addTodo` action with its implementation.
- [src/index.ts](src/index.ts) starts the app, supplies a demo principal,
  creates a todo, reads it by ID, and lists todos through the typed consumer
  API.
- `assertFields` checks availability before using selected fields. `for await`
  consumes all query pages, with authorization applied to each result.

```ts
const { actions, objects } = relate.as(principal);
const receipt = await actions.addTodo({
  input: { title: 'Buy milk', note: 'On the way home' },
  idempotencyKey: 'shopping-1',
});
const todo = await objects.Todo.get(receipt.output.todoId);
```

The host authenticates the principal. The action derives `owner` from that
principal, and another member cannot read or list the todo. Retrying the same
input and key as the same actor returns the original receipt.

This is an add-and-read example. Native update/delete are not implemented, so
editing, completing, and deleting todos are not included. Omitting `store` uses
an isolated memory store: todos and receipts disappear on shutdown.

Next, the [customer workspace](../02-customer-workspace/README.md) adds external
sources, relationships, role and field policies, and a browser interface.
[Postgres persistence](../03-postgres-persistence/README.md) covers durable
storage and restart recovery. See the [four examples](../README.md).
