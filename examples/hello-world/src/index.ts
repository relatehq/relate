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
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';

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
      access: access.groups.ordinary,
    }),
    name: from(people.fields.name, {
      id: 'example.person.name',
      access: access.groups.ordinary,
    }),
  },
});

const graph = defineGraph({
  id: 'example.graph',
  objects: [Person],
  access,
  policies: [
    access.policy(Person, {
      read: { gate: access.role('reader'), evidenceMaxAgeMs: 30_000 },
    }),
  ],
});

const runtime = createRuntime({
  model: compile(graph),
  graphId: 'hello-world',
  sources: {
    [people.id]: {
      connectionId: 'example',
      authorization: 'shared-service',
      connector: {
        async fetch(sourceRecordId) {
          return sourceRecordId === '1'
            ? { state: 'present', record: { id: '1', name: 'Ada' } }
            : { state: 'deleted' };
        },
      },
    },
  },
});

const id = await runtime.adopt(Person.id, '1');

const result = await runtime.read(
  { id: 'example-reader', roles: ['reader'], claims: {} },
  Person.id,
  id,
);

console.log(JSON.stringify(result, null, 2));
