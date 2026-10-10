import { expect, it } from 'vitest';
import { connect } from 'relate';
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
