import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { connect, createRuntime } from '@relate/node';
import { assertFields } from '@relate/protocol';

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
  name: 'Person',
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
  policies: [
    access.policy(Person, {
      read: { gate: access.role('reader'), evidenceMaxAgeMs: 30_000 },
    }),
  ],
});

const relate = createRuntime({
  graph,
  graphId: 'hello-world',
  connections: [
    connect(people, {
      connectionId: 'example',
      connector: {
        async fetch(sourceRecordId) {
          return sourceRecordId === '1'
            ? { state: 'present', record: { id: '1', name: 'Ada' } }
            : { state: 'deleted' };
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
