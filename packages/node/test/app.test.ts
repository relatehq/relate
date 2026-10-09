import { expect, it } from 'vitest';
import { CompileError } from 'relate';
import { createMemoryStore } from '@relate/runtime';
import { createRuntime, startApp } from '@relate/node';
import { connect, defineApp } from 'relate';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { Customer, ana, customers, graph, invoices } = createInvoiceGraph();

const connector = (record: Record<string, unknown>) => ({
  identify: async () => 'example-account',
  fetch: async (id: string) => ({
    providerAccountId: 'example-account' as const,
    state: 'present' as const,
    record: { id, ...record },
  }),
});

const connections = () => [
  connect(customers, {
    connectionId: 'crm',
    providerAccountId: 'example-account',
    connector: connector({ name: 'Northwind', portfolio: 'north', revenue: 1 }),
  }),
  connect(invoices, {
    connectionId: 'billing',
    providerAccountId: 'example-account',
    connector: connector({
      customer_id: 'crm_1',
      status: 'open',
      total_minor: 100,
    }),
  }),
];

it('starts the runtime through setup once and disposes registered resources on close', async () => {
  const events: string[] = [];
  const store = createMemoryStore();
  const app = defineApp({
    graph,
    async setup({ onDispose }) {
      events.push('setup');
      onDispose(() => {
        events.push('dispose:first');
      });
      onDispose(async () => {
        events.push('dispose:second');
      });

      return { connections: connections(), store };
    },
  });
  const relate = await startApp(app);
  const id = await relate.host.adopt(Customer, 'crm_1');
  const read = await relate.as(ana).objects.Customer.get(id, {
    select: ['name'],
  });

  expect(read.status).toBe('ok');

  if (read.status === 'ok') expect(read.data.name).toBe('Northwind');

  await relate.close();
  expect(events).toEqual(['setup', 'dispose:second', 'dispose:first']);
  expect(() => relate.as(ana)).toThrow('closed');
});

it('releases resources registered before a setup or composition failure', async () => {
  const events: string[] = [];

  await expect(
    startApp(
      defineApp({
        graph,
        setup({ onDispose }) {
          onDispose(() => {
            events.push('dispose');
          });
          throw new Error('credentials missing');
        },
      }),
    ),
  ).rejects.toThrow('credentials missing');
  expect(events).toEqual(['dispose']);

  // A missing binding fails startup instead of quietly supplying a fake.
  await expect(
    startApp(
      defineApp({
        graph,
        setup({ onDispose }) {
          onDispose(() => {
            events.push('dispose:bindings');
          });

          return { connections: [] };
        },
      }),
    ),
  ).rejects.toThrow('Missing or unsupported source binding');
  expect(events).toEqual(['dispose', 'dispose:bindings']);
  await expect(startApp(defineApp({ graph }))).rejects.toThrow(
    'Missing or unsupported source binding',
  );
});

it('preserves structured compilation failures through runtime construction', async () => {
  const broken = {
    ...graph,
    policies: {
      ...graph.policies,
      Invoice: { read: { gate: { kind: 'role', role: 'finanse' } } },
    },
  } as never;
  const expectIssues = (error: unknown) => {
    expect(error).toBeInstanceOf(CompileError);
    expect((error as CompileError).issues).toEqual([
      {
        code: 'policy.unknown-role',
        message: "Unknown policy role 'finanse' in policy Invoice.read",
        definitionId: 'business.invoice',
        path: {
          root: 'graph',
          segments: ['policies', 'Invoice', 'read', 'gate'],
        },
      },
    ]);
  };

  try {
    createRuntime({ graph: broken, connections: connections() });
    throw new Error('expected failure');
  } catch (error) {
    expectIssues(error);
  }

  const events: string[] = [];

  try {
    await startApp(
      defineApp({
        graph: broken,
        setup({ onDispose }) {
          onDispose(() => {
            events.push('dispose');
          });

          return { connections: connections() };
        },
      }),
    );
    throw new Error('expected failure');
  } catch (error) {
    expectIssues(error);
  }

  expect(events).toEqual(['dispose']);
});
