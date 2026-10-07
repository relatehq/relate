# @relate/node

Application composition for Node: compile an authored graph, bind connections
and action implementations, and expose a typed, authorized consumer API. Private
and unpublished while implementation is in progress.

## Responsibility

- `createRuntime({ graph, connections, actionImplementations?, store?, … })`
  compiles the graph with `relate/compiler`, validates connections against the
  registered sources, binds action handlers, and starts a `@relate/runtime`
  engine.
- `relate.as(principal)` returns consumer operations whose names and types are
  inferred from the graph's object registry: `objects.Customer.get`,
  `objects.Customer.traverse.invoices`, `actions.addAccountReview`.
- `relate.host.adopt(Customer, sourceRecordId)` is the trusted membership
  operation; `relate.close()` drains in-flight work.
- `connect(source, { connectionId, connector })` binds a source definition to a
  connector.

Authorization, transactions and evidence belong to the engine. This package adds
types, composition and lifecycle. Storage defaults to isolated memory; an
injected store is borrowed.

## How it fits

- Depends on `relate` and `relate/compiler`, `@relate/runtime` and
  `@relate/protocol`.
- The embedded entry point for applications today. The planned `@relate/http`,
  `@relate/mcp` and `@relate/cli` build on a runtime composed here.

## Public API

```ts
import { z } from 'zod';
import {
  assertFields,
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { connect, createRuntime } from '@relate/node';

const people = defineSource({
  id: 'example.people',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});
const Person = defineObject({
  id: 'example.person',
  membership: source(people),
  properties: {
    id: objectId({ id: 'example.person.id' }),
    name: from(people.fields.name, { id: 'example.person.name' }),
  },
});
const access = defineAccess({
  roles: ['reader'],
  claims: {},
  fieldGroups: ['ordinary'],
});
const graph = defineGraph({
  id: 'example.graph',
  objects: { Person },
  access,
  policies: { Person: { read: { gate: access.role('reader') } } },
});

const relate = createRuntime({
  graph,
  connections: [
    connect(people, {
      connectionId: 'directory',
      providerAccountId: 'example-account',
      connector: {
        // This in-memory fixture is its own provider. Real adapters authenticate.
        identify: async () => 'example-account',
        async fetch(id) {
          return id === '1'
            ? {
                providerAccountId: 'example-account',
                state: 'present',
                record: { id: '1', name: 'Ada' },
              }
            : { providerAccountId: 'example-account', state: 'deleted' };
        },
      },
    }),
  ],
});

try {
  const id = await relate.host.adopt(Person, '1'); // ObjectId<'example.person'>
  const { objects } = relate.as({
    id: 'reader-1',
    roles: ['reader'],
    claims: {},
  });
  const person = await objects.Person.get(id, { select: ['name'] });

  assertFields(person, ['name']); // a selected field can still be withheld
  console.log(person.data.name); // string
} finally {
  await relate.close();
}
```

With relationships and actions registered in the graph, the same handle exposes
traversal and action calls:

```ts
const { objects, actions } = relate.as(ana);

const page = await objects.Customer.traverse.invoices(customerId, {
  select: ['status'],
  limit: 25,
});

for await (const invoice of objects.Customer.traverse.invoices(customerId)) {
  console.log(invoice.id, invoice.data.status);
}

const receipt = await actions.addAccountReview({
  input: { customer: customerId, note: 'Follow up' },
  idempotencyKey: 'review-2026-10',
});
```

## Status

Implemented: typed reads, source-backed references, bidirectional traversal with
pagination, and native actions with atomic receipts. Not implemented: collection
queries, automatic synchronization, servers and workers. `defineApp` and
`startApp` from the [inspector specification](../../apps/inspector/SPEC.md) are
proposals, not exports.

## Further reading

- [CONTRACT.md](./CONTRACT.md): read, adoption, connection, traversal and cursor
  semantics in detail.
- [NATIVE_ACTIONS.md](./NATIVE_ACTIONS.md): the account-review action path end
  to end.
- [Hello world](../../examples/hello-world/README.md) and
  [Postgres persistence](../../examples/postgres-persistence/README.md).
