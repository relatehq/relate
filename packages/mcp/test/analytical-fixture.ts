import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { expect, onTestFinished } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { sqlite } from '@relate/connector-sqlite';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import {
  bind,
  computed,
  defineAccess,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import { compile } from 'relate/compiler';
import {
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';
import type { ExecutionResult } from '@relate/mcp';
import { testCreation } from '../../../tests/support/activity.js';

/** Real runtime and SQL, owned by each transport test; no tutorial imports. */
export async function analyticalFixture() {
  const access = defineAccess({
    roles: ['reader', 'analyst', 'support'],
    fieldGroups: ['ordinary', 'private'],
    claims: { portfolio: z.string() },
  });
  const Events = defineDataset({
    id: 'events',
    columns: {
      customerId: {
        id: 'events.customer',
        schema: z.string(),
        access: access.groups.ordinary,
      },
      amount: {
        id: 'events.amount',
        schema: z.int64(),
        access: access.groups.ordinary,
      },
      occurredAt: {
        id: 'events.at',
        schema: z.iso.datetime({ offset: true, precision: 3 }),
        access: access.groups.ordinary,
      },
      secret: {
        id: 'events.secret',
        schema: z.string(),
        access: access.groups.private,
        description: 'Private customer detail.',
      },
    },
  });
  const Customer = defineObject({
    id: 'customer',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'customer.id' }),
      key: native(z.string(), { id: 'customer.key' }),
      name: native(z.string(), { id: 'customer.name' }),
      portfolio: native(z.string(), { id: 'customer.portfolio' }),
      count: computed({
        id: 'customer.count',
        sql: 'SELECT COUNT(*) FROM self.events',
      }),
      privateCount: computed({
        id: 'customer.private-count',
        sql: 'SELECT COUNT(DISTINCT secret) FROM self.events',
      }),
    },
    datasets: {
      events: {
        id: 'customer.events',
        dataset: Events,
        on: [{ column: 'customerId', property: 'key' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'mcp-analytical',
    access,
    objects: { Customer },
    datasets: { Events },
    policies: {
      Customer: {
        read: {
          gate: access.role('reader'),
          evidenceMaxAgeMs: 60_000,
          where: { portfolio: { eq: access.claims.portfolio } },
        },
        datasets: { events: { gate: access.role('analyst') } },
      },
      Events: { groups: { private: access.role('support') } },
    },
  });
  const directory = await mkdtemp(join(tmpdir(), 'relate-mcp-read-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private-provider.sqlite');
  const database = new DatabaseSync(path);

  try {
    database.exec(
      'CREATE TABLE private_events(customer_key TEXT NOT NULL, event_amount INTEGER NOT NULL, event_at TEXT NOT NULL, private_detail TEXT NOT NULL)',
    );
    const insert = database.prepare(
      'INSERT INTO private_events VALUES (?, ?, ?, ?)',
    );

    insert.run(
      'a',
      9007199254740993n,
      '2026-10-02T10:00:00.000Z',
      'private-one',
    );
    insert.run('a', 2n, '2026-10-09T10:00:00.000Z', 'private-two');
    insert.run('b', 10n, '2026-10-03T10:00:00.000Z', 'private-three');
    insert.run('d', 100n, '2026-10-10T10:00:00.000Z', 'private-outside');
  } finally {
    database.close();
  }

  const connection = sqlite({ connectionId: 'private-connection', path });

  onTestFinished(() => connection.close());
  const counters = { statements: 0 };
  const hooks: { failStatement?: boolean } = {};
  const resource = connection.table('private_events');
  const selected = {
    ...resource,
    connection: {
      ...connection,
      analytics: {
        ...connection.analytics,
        execute: async (
          ...args: Parameters<typeof connection.analytics.execute>
        ) => {
          counters.statements++;

          if (hooks.failStatement)
            throw new Error(`private-driver-error: ${path}`);

          return connection.analytics.execute(...args);
        },
      },
    },
  };
  const model = compile(graph);
  const store = createMemoryStore();
  const scope = {
    graphId: graph.id,
    definitionRevision: model.definitionRevision,
  };

  await store.install(scope.graphId, scope.definitionRevision);
  await store.native!.transaction(scope, async (transaction) => {
    for (const [id, name, portfolio] of [
      ['a', 'Acme', 'north'],
      ['b', 'Globex', 'north'],
      ['c', 'Initech', 'north'],
      ['d', 'Umbrella', 'south'],
    ] as const) {
      await transaction.insert(
        {
          objectDefinitionId: Customer.id,
          objectId: id,
          createdAt: Date.now(),
          values: {
            'customer.key': id,
            'customer.name': name,
            'customer.portfolio': portfolio,
          },
        },
        testCreation(),
      );
    }
  });
  const runtime = await startApp(
    defineApp({
      graph,
      setup: () => ({
        store,
        cursorKey: new Uint8Array(32).fill(7),
        analytics: { maxKeysPerStatement: 2 },
        bindings: [
          bind(Events, selected, {
            columns: {
              customerId: 'customer_key',
              amount: 'event_amount',
              occurredAt: 'event_at',
              secret: 'private_detail',
            },
          }),
        ],
      }),
    }),
  );

  onTestFinished(() => runtime.close());
  const principals = {
    ana: {
      id: 'ana',
      roles: ['reader', 'analyst'],
      claims: { portfolio: 'north' },
    },
    fin: { id: 'fin', roles: ['reader'], claims: { portfolio: 'north' } },
    support: {
      id: 'support',
      roles: ['reader', 'analyst', 'support'],
      claims: { portfolio: 'north' },
    },
  };
  const handler = createStreamableHttpHandler({
    executor: createDevelopmentExecutor(),
    bindGraph(request) {
      const token = request.headers
        .get('authorization')
        ?.replace('Bearer ', '');
      const principal =
        token && Object.hasOwn(principals, token)
          ? principals[token as keyof typeof principals]
          : undefined;

      return principal
        ? {
            description: model.consumer,
            operations: runtime.operations(principal),
          }
        : new Response('Unauthorized', { status: 401 });
    },
  });

  return {
    runtime,
    principals,
    counters,
    hooks,
    directory,
    async connect(actor: keyof typeof principals) {
      const client = new Client({
        name: 'analytical-conformance',
        version: '1',
      });

      onTestFinished(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          requestInit: { headers: { authorization: `Bearer ${actor}` } },
          fetch: (input, init) => handler(new Request(input, init)),
        }),
      );
      const call = (code: string) =>
        client.callTool({ name: 'execute', arguments: { code } });

      return {
        client,
        call,
        async execute<T>(code: string): Promise<T> {
          const response = await call(code);
          const content = response.structuredContent as ExecutionResult;

          expect(content, JSON.stringify(content)).toMatchObject({
            status: 'succeeded',
            logs: [],
          });

          if (content.status !== 'succeeded')
            throw new Error(content.error.message);

          expect(response.isError).not.toBe(true);
          expect(response.content).toEqual([
            { type: 'text', text: JSON.stringify(content) },
          ]);

          return content.result as T;
        },
      };
    },
  };
}
