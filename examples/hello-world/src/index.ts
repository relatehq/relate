import { z } from 'zod';
import {
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';

const people = defineSource({
  definitionId: 'example.people',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});

const Person = defineObject({
  definitionId: 'example.person',
  name: 'Person',
  membership: source(people),
  properties: {
    id: objectId({ definitionId: 'example.person.id', access: 'ordinary' }),
    name: from(people.fields.name, {
      definitionId: 'example.person.name',
      access: 'ordinary',
    }),
  },
});

const graph = defineGraph({
  definitionId: 'example.graph',
  objects: [Person],
  fieldGroups: ['ordinary'],
  policies: {
    [Person.definitionId]: {
      read: { role: 'reader', evidenceMaxAgeMs: 30_000 },
      groups: {},
    },
  },
});

const runtime = createRuntime({
  model: compile(graph),
  graphId: 'hello-world',
  sources: {
    [people.definitionId]: {
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

const id = await runtime.adopt(Person.definitionId, '1');

const result = await runtime.read(
  { id: 'example-reader', roles: ['reader'], claims: {} },
  Person.definitionId,
  id,
);

console.log(JSON.stringify(result, null, 2));
