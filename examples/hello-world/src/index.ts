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

const access = defineAccess({
  roles: ['reader'],
  fieldGroups: ['ordinary'],
  claims: {},
});

const people = defineSource({
  id: 'example.people',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});

const Person = defineObject({
  id: 'example.person',
  label: 'Person',
  pluralLabel: 'People',
  description: 'People available from the connected directory.',
  membership: source(people),
  properties: {
    id: objectId({
      id: 'example.person.id',
    }),
    name: from(people.fields.name, {
      id: 'example.person.name',
    }),
  },
});

const graph = defineGraph({
  id: 'example.graph',
  objects: { Person },
  access,
  policies: {
    Person: {
      read: { gate: access.role('reader') },
    },
  },
});

const relate = createRuntime({
  graph,
  graphId: 'hello-world',
  connections: [
    connect(people, {
      providerAccountId: 'example-account',
      connectionId: 'example',
      connector: {
        identify: async () => 'example-account',
        async fetch(sourceRecordId) {
          return sourceRecordId === '1'
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
  const id = await relate.host.adopt(Person, '1');
  const { objects } = relate.as({
    id: 'example-reader',
    roles: ['reader'],
    claims: {},
  });
  const result = await objects.Person.get(id, { select: ['name'] });

  // Selection preserves field types, but a field may still be unavailable.
  assertFields(result, ['name']);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await relate.close();
}
