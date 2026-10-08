import { z } from 'zod';
import {
  connect,
  defineAccess,
  defineApp,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import type { AppBindings } from 'relate';
import type { SourceConnector, SourceRecord } from 'relate/connectors';
import type { ObservationStore } from 'relate/storage';

const people = defineSource({
  id: 'people',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string() }),
});
const Person = defineObject({
  id: 'person',
  membership: source(people),
  properties: {
    id: objectId({ id: 'person.id' }),
    name: from(people.fields.name, { id: 'person.name' }),
  },
});
const access = defineAccess({ roles: ['reader'], fieldGroups: [], claims: {} });
const graph = defineGraph({
  id: 'app',
  objects: { Person },
  access,
  policies: { Person: { read: { gate: access.role('reader') } } },
});
const connector: SourceConnector = {
  async identify({ signal }) {
    signal.throwIfAborted();

    return 'fixture';
  },
  async fetch(id, { signal }) {
    signal.throwIfAborted();

    return {
      providerAccountId: 'fixture',
      state: 'present',
      record: { id, name: 'Ada' },
    };
  },
};

// This entire application and its declarations need only relate and zod.
export const app = defineApp({
  graph,
  setup({ onDispose }) {
    onDispose(async () => {});

    // @ts-expect-error disposal must be callable
    onDispose('close');

    return {
      connections: [
        connect(people, {
          connectionId: 'directory',
          providerAccountId: 'fixture',
          connector,
        }),
      ],
    };
  },
});

const person: typeof Person = app.graph.objects.Person;

// @ts-expect-error app graph retains its exact object registry
app.graph.objects.Invoice;
// @ts-expect-error all source outcomes require account evidence
const missingAccount: SourceRecord = { state: 'deleted' };

// @ts-expect-error setup must return runtime bindings
defineApp({ graph, setup: () => ({}) });

export function withStore(store: ObservationStore): AppBindings<typeof graph> {
  return { connections: [], store };
}

void [person, missingAccount];
