import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  bind,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  defineSource,
  objectId,
  source,
} from 'relate';
import type { DatasetBinding } from 'relate';
import type { PhysicalSchema } from 'relate/connectors';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { bindHostResources } from '../src/datasets.js';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  createAnalyticalConnector,
  analyticalGraphSchema,
} from '../../../tests/support/analytical-connector.js';

it('inspects every dataset at every startup and releases registered connections once', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const close = vi.fn();
  const app = defineApp({
    graph,
    setup({ onDispose }) {
      onDispose(close);

      return { bindings: [bind(Events, connector.table('events'))] };
    },
  });
  const first = await startApp(app);

  expect(connector.described).toHaveLength(1);
  await first.close();
  await first.close();
  expect(close).toHaveBeenCalledTimes(1);
  const second = await startApp(app);

  expect(connector.described).toHaveLength(2);
  expect(connector.described[0]).not.toBe(connector.described[1]);
  await second.close();
  expect(close).toHaveBeenCalledTimes(2);
});

it.each([
  ['missing column', { columns: {} }, 'missing'],
  [
    'different type',
    {
      columns: {
        ...analyticalGraphSchema().columns,
        amount: {
          supportedTypes: [{ type: 'float64' }],
          nullable: false,
          databaseType: 'DOUBLE',
        },
      },
    },
    'int64',
  ],
  [
    'nullable physical key',
    {
      columns: {
        ...analyticalGraphSchema().columns,
        customerId: {
          supportedTypes: [{ type: 'string' }],
          nullable: true,
          databaseType: 'TEXT',
        },
      },
    },
    'nullability',
  ],
  [
    'malformed supported types',
    {
      columns: {
        ...analyticalGraphSchema().columns,
        amount: {
          supportedTypes: null,
          nullable: false,
          databaseType: 'BIGINT',
        },
      },
    },
    'int64',
  ],
  [
    'malformed nullability',
    {
      columns: {
        ...analyticalGraphSchema().columns,
        amount: {
          supportedTypes: [{ type: 'int64' }],
          nullable: 'no',
          databaseType: 'BIGINT',
        },
      },
    },
    'nullability',
  ],
])(
  'rejects %s and disposes resources before startup returns',
  async (_label, schema, message) => {
    const { graph, Events } = createAnalyticalGraph();
    const connector = createAnalyticalConnector(schema as PhysicalSchema);
    const dispose = vi.fn();

    await expect(
      startApp(
        defineApp({
          graph,
          setup({ onDispose }) {
            onDispose(dispose);

            return { bindings: [bind(Events, connector.table('events'))] };
          },
        }),
      ),
    ).rejects.toThrow(message);
    expect(dispose).toHaveBeenCalledTimes(1);
  },
);

it('reports schema inspection failure without driver details and disposes in reverse order', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const cause = new Error('private server and credential details');

  connector.connection.analytics.describe = async () => {
    throw cause;
  };
  const events: string[] = [];

  try {
    await startApp(
      defineApp({
        graph,
        setup({ onDispose }) {
          onDispose(() => {
            events.push('first');
          });
          onDispose(() => {
            events.push('second');
          });

          return { bindings: [bind(Events, connector.table('events'))] };
        },
      }),
    );
    expect.fail('Expected startup failure');
  } catch (error) {
    expect((error as Error).message).toBe(
      'Could not inspect dataset binding Events',
    );
    expect((error as Error).cause).toBe(cause);
    expect(JSON.stringify(error)).not.toContain('credential');
  }

  expect(events).toEqual(['second', 'first']);
});

it('rejects missing, duplicate, foreign and unsupported bindings before inspection', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const binding = bind(Events, connector.table('events'));
  const cases: [DatasetBinding[], string][] = [
    [[], 'Missing dataset binding'],
    [[binding, binding], 'Duplicate dataset binding'],
    [[{ ...binding, dataset: { ...Events } }], 'Unregistered dataset binding'],
    [
      [
        {
          ...binding,
          connection: {
            connectionId: 'other',
            analytics: connector.connection.analytics,
          },
        },
      ],
      'Invalid configured connection identity',
    ],
    [
      [
        {
          ...binding,
          connection: { connectionId: 'analytics', analytics: {} as never },
        },
      ],
      'analytical capability',
    ],
  ];

  for (const [bindings, message] of cases)
    await expect(
      startApp(defineApp({ graph, setup: () => ({ bindings }) })),
    ).rejects.toThrow(message);

  expect(connector.described).toEqual([]);
});

it('shares one queue for datasets on one connection and rejects conflicting instances', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const Second = defineDataset({
    id: 'second',
    columns: {
      value: {
        id: 'second.value',
        schema: z.string(),
        access: graph.access.groups.ordinary,
      },
    },
  });
  const input = defineGraph({
    ...graph,
    datasets: { Events, Second },
    policies: { ...graph.policies, Second: {} },
  });
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const first = bind(Events, connector.table('events'));
  const second = bind(Second, connector.table('other'));
  const host = bindHostResources(input, compile(input), [first, second], {
    concurrency: 1,
    maxQueued: 0,
  });

  expect(host.datasets.get(Events.id)!.queue).toBe(
    host.datasets.get(Second.id)!.queue,
  );
  const task = vi.fn(async () => 1);
  let release!: () => void;
  const running = host.datasets.get(Events.id)!.queue.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    { signal: new AbortController().signal },
  );

  try {
    await expect(
      host.datasets
        .get(Second.id)!
        .queue.run(task, { signal: new AbortController().signal }),
    ).rejects.toThrow('busy');
    expect(task).not.toHaveBeenCalled();
  } finally {
    release();
    await running;
  }

  await host.retire();
  await expect(
    host.datasets
      .get(Events.id)!
      .queue.run(task, { signal: new AbortController().signal }),
  ).rejects.toThrow('retired');
  expect(task).not.toHaveBeenCalled();
  const other = createAnalyticalConnector(analyticalGraphSchema());

  expect(() =>
    bindHostResources(input, compile(input), [
      first,
      bind(Second, other.table('other')),
    ]),
  ).toThrow('Conflicting instances');
});

it('preserves connection identity across source and dataset capabilities', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const customers = defineSource({
    id: 'customers',
    idField: 'id',
    schema: z.object({ id: z.string() }),
  });
  const Directory = defineObject({
    id: 'directory',
    membership: source(customers),
    properties: { id: objectId({ id: 'directory.id' }) },
  });
  const input = defineGraph({
    ...graph,
    objects: { ...graph.objects, Directory },
    policies: { ...graph.policies, Directory: { read: 'deny' } },
  });
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const keyed = {
    connection: connector.connection,
    resourceId: 'customers',
    bindSource: () => ({
      identity: 'application' as const,
      async fetch() {
        return { state: 'deleted' as const };
      },
    }),
  };
  const runtime = await startApp(
    defineApp({
      graph: input,
      setup: () => ({
        bindings: [
          bind(customers, keyed),
          bind(Events, connector.table('events')),
        ],
      }),
    }),
  );

  await runtime.close();
  const other = { ...keyed, connection: { connectionId: 'analytics' } };

  await expect(
    startApp(
      defineApp({
        graph: input,
        setup: () => ({
          bindings: [
            bind(customers, other),
            bind(Events, connector.table('events')),
          ],
        }),
      }),
    ),
  ).rejects.toThrow('Conflicting instances');
});

it('checks unused datasets and exact timestamp precision while allowing stricter nullability', async () => {
  const { graph } = createAnalyticalGraph();
  const Times = defineDataset({
    id: 'times',
    columns: {
      at: {
        id: 'times.at',
        schema: z.iso.datetime({ offset: true, precision: 6 }).nullable(),
        access: graph.access.groups.ordinary,
      },
    },
  });
  const input = defineGraph({
    id: 'times.graph',
    access: graph.access,
    objects: {},
    datasets: { Times },
    policies: { Times: {} },
  });
  const schema: PhysicalSchema = {
    columns: {
      at: {
        supportedTypes: [{ type: 'timestamp', precision: 3 }],
        nullable: false,
        databaseType: 'TEXT',
      },
    },
  };
  const connector = createAnalyticalConnector(schema);
  const app = defineApp({
    graph: input,
    setup: () => ({ bindings: [bind(Times, connector.table('times'))] }),
  });

  await expect(startApp(app)).rejects.toThrow('timestamp');
  const precise = createAnalyticalConnector({
    columns: {
      at: {
        supportedTypes: [{ type: 'timestamp', precision: 6 }],
        nullable: false,
        databaseType: 'TEXT',
      },
    },
  });
  const runtime = await startApp(
    defineApp({
      graph: input,
      setup: () => ({ bindings: [bind(Times, precise.table('times'))] }),
    }),
  );

  await runtime.close();
});

it('does not expose a runtime until inspection settles and captures registries before the wait', async () => {
  const { graph, Events, Customer } = createAnalyticalGraph();
  const input = { ...graph, objects: { ...graph.objects } };
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const inspection = new Promise<void>((resolve) => {
    release = resolve;
  });

  connector.connection.analytics.describe = async () => {
    enter();
    await inspection;

    return analyticalGraphSchema();
  };
  let returned = false;
  const starting = startApp(
    defineApp({
      graph: input,
      setup: () => ({ bindings: [bind(Events, connector.table('events'))] }),
    }),
  ).then((runtime) => {
    returned = true;

    return runtime;
  });

  await entered;
  expect(returned).toBe(false);
  // Mutating a caller-owned registry during I/O cannot change the compiled facade.
  delete (input.objects as Record<string, unknown>).Customer;
  release();
  const runtime = await starting;

  expect(
    runtime
      .as({ id: 'reader', roles: ['reader'], claims: {} })
      .objects.Customer.describe()!.definitionId,
  ).toBe(Customer.id);
  await runtime.close();
});

it('clamps and shares capacity across runtimes without retiring another host', async () => {
  const { graph, Events } = createAnalyticalGraph();
  const connector = createAnalyticalConnector(analyticalGraphSchema());

  Object.assign(connector.connection.analytics.limits, {
    maxConcurrentStatements: 1,
  });
  const binding = bind(Events, connector.table('events'));
  const first = bindHostResources(graph, compile(graph), [binding], {
    concurrency: 8,
  });
  const second = bindHostResources(graph, compile(graph), [binding], {
    concurrency: 8,
  });
  const signal = new AbortController().signal;
  let release!: () => void;
  const started = vi.fn();
  const running = first.datasets.get(Events.id)!.queue.run(
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    { signal },
  );

  await vi.waitFor(() => expect(release).toBeDefined());
  const waiting = second.datasets.get(Events.id)!.queue.run(
    async () => {
      started();

      return 42;
    },
    { signal },
  );

  await Promise.resolve();
  expect(started).not.toHaveBeenCalled();
  release();
  await running;
  await first.retire();
  expect(await waiting).toBe(42);
  expect(
    await second.datasets.get(Events.id)!.queue.run(async () => 43, { signal }),
  ).toBe(43);
  await second.retire();
});
