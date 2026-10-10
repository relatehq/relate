import { expect, it } from 'vitest';
import { connect, defineAction, defineGraph, implementAction } from 'relate';
import { z } from 'zod';
import type { SourceConnector } from 'relate/connectors';
import { createRuntime } from '@relate/node';
import { createConsumer } from 'relate/consumer';
import { ActionError } from '@relate/protocol';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

/** One customer with two invoices; `ana` reads the north portfolio. */
function createInvoiceApp() {
  const model = createInvoiceGraph();
  const rows = {
    customers: new Map([
      ['c1', { id: 'c1', name: 'Northwind', portfolio: 'north', revenue: 5 }],
    ]),
    invoices: new Map([
      ['i1', { id: 'i1', customer_id: 'c1', status: 'Paid', total_minor: 10 }],
      ['i2', { id: 'i2', customer_id: 'c1', status: 'Open', total_minor: 20 }],
    ]),
  };
  const connector = (
    records: Map<string, Record<string, string | number>>,
  ): SourceConnector => ({
    identify: async () => 'account',
    fetch: async (id) => {
      const record = records.get(id);

      return record
        ? { providerAccountId: 'account', state: 'present', record }
        : { providerAccountId: 'account', state: 'deleted' };
    },
  });
  const relate = createRuntime({
    graph: model.graph,
    connections: [
      connect(model.customers, {
        connectionId: 'crm',
        providerAccountId: 'account',
        connector: connector(rows.customers),
      }),
      connect(model.invoices, {
        connectionId: 'billing',
        providerAccountId: 'account',
        connector: connector(rows.invoices),
      }),
    ],
  });

  return { ...model, relate };
}

it('exposes the engine as definition-ID operations bound to one principal', async () => {
  const { relate, ana, Customer, Invoice } = createInvoiceApp();
  const customerId = await relate.host.adopt(Customer, 'c1');
  const invoiceIds = [
    await relate.host.adopt(Invoice, 'i1'),
    await relate.host.adopt(Invoice, 'i2'),
  ];
  const operations = relate.operations(ana);

  // Engine envelope: no `id`; the facade adds it.
  const read = await operations.read(Customer.id, customerId, {
    select: ['name'],
  });

  expect(read).toMatchObject({ status: 'ok', data: { name: 'Northwind' } });
  expect(read).not.toHaveProperty('id');

  const page = await operations.query(Invoice.id, {
    where: { status: 'Open' },
  });

  expect(page.data.map((invoice) => invoice.id)).toEqual([invoiceIds[1]]);

  const invoices = await operations.traverse(
    Customer.id,
    customerId,
    'invoices',
    { select: ['status'] },
  );

  expect('status' in invoices).toBe(false);
  expect(
    'data' in invoices &&
      Array.isArray(invoices.data) &&
      invoices.data.map((invoice) => invoice.id).sort(),
  ).toEqual([...invoiceIds].sort());

  const customer = await operations.traverse(
    Invoice.id,
    invoiceIds[0]!,
    'customer',
  );

  expect(customer).toMatchObject({ status: 'ok', id: customerId });

  expect(operations.discovery.describe().objects.map((o) => o.apiName)).toEqual(
    ['Customer', 'Invoice'],
  );
  expect(operations.discovery.describeObject(Customer.id)?.apiName).toBe(
    'Customer',
  );
  expect(operations.discovery.describeAction('missing')).toBeUndefined();

  await relate.close();
});

it('keeps authorization and request validation in the engine, not the caller', async () => {
  const { relate, ana, Customer } = createInvoiceApp();
  const customerId = await relate.host.adopt(Customer, 'c1');
  const stranger = relate.operations({
    ...ana,
    id: 'south',
    claims: { portfolio: 'south' },
  });

  await expect(stranger.read(Customer.id, customerId)).resolves.toEqual({
    status: 'not-found',
  });
  await expect(
    relate.operations(ana).query(Customer.id, { where: { missing: 1 } }),
  ).rejects.toMatchObject({ name: 'ReadError', code: 'invalid-request' });
  await expect(
    relate.operations(ana).getReceipt('unknown-action', 'inv'),
  ).rejects.toBeInstanceOf(ActionError);

  await relate.close();
});

it('is the port behind as(): the facade over operations() behaves identically', async () => {
  const { relate, ana, graph, Customer } = createInvoiceApp();
  const customerId = await relate.host.adopt(Customer, 'c1');
  const viaFacade = await relate.as(ana).objects.Customer.get(customerId, {
    select: ['name'],
  });
  const viaPort = await createConsumer(
    graph,
    relate.operations(ana),
  ).objects.Customer.get(customerId, { select: ['name'] });

  expect(viaPort).toEqual(viaFacade);
  expect(viaPort).toMatchObject({ status: 'ok', id: customerId });

  await relate.close();
});

it('rejects every operation and discovery call after close', async () => {
  const { relate, ana, Customer } = createInvoiceApp();
  const customerId = await relate.host.adopt(Customer, 'c1');
  const operations = relate.operations(ana);

  await relate.close();

  await expect(operations.read(Customer.id, customerId)).rejects.toThrow(
    'closed',
  );
  await expect(operations.query(Customer.id)).rejects.toThrow('closed');
  expect(() => operations.discovery.describe()).toThrow('closed');
  expect(() => operations.discovery.describeObject(Customer.id)).toThrow(
    'closed',
  );
  expect(() => relate.operations(ana)).toThrow('closed');
});

it('keeps later consumers aligned with the compiled object and relationship registries', async ({
  onTestFinished,
}) => {
  const { relate, graph, ana, Customer, Invoice } = createInvoiceApp();

  onTestFinished(() => relate.close());

  const customerId = await relate.host.adopt(Customer, 'c1');
  const invoiceId = await relate.host.adopt(Invoice, 'i1');

  // Definitions are frozen, but the registries supplied by the caller are not.
  Reflect.deleteProperty(graph.objects, 'Invoice');
  Reflect.deleteProperty(graph.relationships, 'CustomerInvoices');

  const consumer = relate.as(ana);

  expect(Object.keys(consumer.objects)).toEqual(['Customer', 'Invoice']);
  expect(consumer.objects.Customer.describe()?.traversals[0]?.name).toBe(
    'invoices',
  );
  const page = await consumer.objects.Customer.traverse.invoices(customerId);

  expect(page.data.map((invoice) => invoice.id)).toEqual([invoiceId]);
  await expect(consumer.objects.Invoice.get(invoiceId)).resolves.toMatchObject({
    status: 'ok',
    id: invoiceId,
  });
});

it('keeps registered actions and receipts when the caller changes the graph or options', async ({
  onTestFinished,
}) => {
  const { graph: base, Customer, ana } = createInvoiceGraph();
  const access = base.access;
  const Ping = defineAction({
    id: 'ping',
    input: z.object({}),
    output: z.object({ message: z.string() }),
    creates: [],
    policy: { execute: access.role('employee') },
  });
  const graph = defineGraph({
    ...base,
    objects: { Customer },
    relationships: {},
    actions: { ping: Ping },
    access,
    policies: { Customer: { read: 'deny' } },
  });
  const options = {
    graph,
    connections: [
      connect(base.objects.Customer.membership.resource, {
        connectionId: 'crm',
        connector: {
          identity: 'application' as const,
          fetch: async () => ({ state: 'deleted' as const }),
        },
      }),
    ],
    actionImplementations: [
      implementAction(graph, Ping, async () => ({ message: 'pong' })),
    ],
  };
  const relate = createRuntime(options);

  onTestFinished(() => relate.close());
  Reflect.deleteProperty(graph.actions, 'ping');
  options.graph = {
    ...graph,
    objects: { ...graph.objects },
    actions: { ...graph.actions },
  };

  const consumer = relate.as(ana);

  expect(Object.keys(consumer.actions)).toEqual(['ping']);
  const receipt = await consumer.actions.ping({
    input: {},
    idempotencyKey: 'ping-1',
  });

  expect(receipt).toMatchObject({
    state: 'succeeded',
    output: { message: 'pong' },
  });
  await expect(
    consumer.receipts.get(Ping, receipt.invocationId),
  ).resolves.toEqual(receipt);
});
