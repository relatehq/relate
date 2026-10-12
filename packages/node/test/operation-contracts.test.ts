import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import { connect } from 'relate';
import type { SourceConnector } from 'relate/connectors';
import { createRuntime } from '@relate/node';
import { operationContracts } from '@relate/runtime';
import { ReadError } from '@relate/protocol';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

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
    cursorKey: new Uint8Array(32).fill(3),
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

async function readError(operation: () => unknown): Promise<ReadError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ReadError);

    return error as ReadError;
  }

  throw new Error('Expected a ReadError');
}

it('discovers the generic read contract and each object’s concrete calls', async () => {
  const { relate, ana } = createInvoiceApp();
  const consumer = relate.as(ana);

  expect(consumer.describe().operations).toBe(operationContracts);
  expect(consumer.describe().operations.query.options).toEqual([
    'where',
    'select',
    'limit',
    'cursor',
    'evidence',
    'stale',
    'maxAgeMs',
    'refresh',
    'requireComplete',
    'timeoutMs',
  ]);
  expect(consumer.describe().operations.traverse.many.options).toEqual(
    consumer.describe().operations.query.options,
  );
  expect(consumer.describe().operations.traverse.one.options).toEqual([
    'select',
    'evidence',
    'stale',
    'maxAgeMs',
    'refresh',
    'requireComplete',
    'timeoutMs',
  ]);
  expect(
    consumer.describe().operations.options.map((option) => option.name),
  ).toEqual(consumer.describe().operations.query.options);

  expect(consumer.objects.Customer.describe()).toMatchObject({
    operations: {
      get: {
        call: 'objects.Customer.get(id, options?)',
        returns: 'Promise<ObjectResult<Customer>>',
      },
      query: {
        call: 'objects.Customer.query(options?)',
        returns: 'QueryResult<Customer>',
        collectionScope: 'graph-membership',
      },
    },
    traversals: [
      {
        name: 'invoices',
        cardinality: 'many',
        call: 'objects.Customer.traverse.invoices(id, options?)',
        returns: 'QueryResult<Invoice>',
      },
    ],
  });
  expect(consumer.objects.Invoice.describe()).toMatchObject({
    properties: [
      { name: 'customer', kind: 'reference', filter: 'Customer object ID' },
      { name: 'id', kind: 'object-id', filter: 'Invoice object ID' },
      { name: 'status', kind: 'value', filter: 'string' },
    ],
    traversals: [
      {
        name: 'customer',
        cardinality: 'one',
        call: 'objects.Invoice.traverse.customer(id, options?)',
        returns: 'Promise<ObjectResult<Customer>>',
      },
    ],
  });
  expect(consumer.objects.Customer.describe()).toBe(
    consumer.objects.Customer.describe(),
  );
  expect(
    Object.isFrozen(consumer.objects.Customer.describe()?.traversals[0]),
  ).toBe(true);

  await relate.close();
});

it('prints operations as call signatures instead of implementation source', async () => {
  const { relate, ana } = createInvoiceApp();
  const { Customer, Invoice } = relate.as(ana).objects;

  expect(String(Customer.traverse.invoices)).toBe(
    'objects.Customer.traverse.invoices(id: ObjectId<Customer>, options?: { where?, select?, limit?, cursor?, evidence?, stale?, maxAgeMs?, refresh?, requireComplete?, timeoutMs? }): QueryResult<Invoice>',
  );
  expect(inspect(Invoice.traverse.customer)).toBe(
    'objects.Invoice.traverse.customer(id: ObjectId<Invoice>, options?: { select?, evidence?, stale?, maxAgeMs?, refresh?, requireComplete?, timeoutMs? }): Promise<ObjectResult<Customer>>',
  );
  expect(String(Customer.query)).toMatch(
    /^objects\.Customer\.query\(options\?: \{ where\?, select\?, limit\?, cursor\?/,
  );
  expect(String(Customer.get)).toMatch(
    /^objects\.Customer\.get\(id: ObjectId<Customer>/,
  );

  await relate.close();
});

it('names unknown paging options and the accepted generic options', async () => {
  const { relate, ana } = createInvoiceApp();
  const error = await readError(() =>
    relate
      .as(ana)
      .objects.Customer.query({ pageSize: 10, pageIndex: 0 } as never),
  );

  expect(error).toMatchObject({
    code: 'invalid-request',
    operation: 'Customer.query',
    issues: [
      { path: ['pageSize'], problem: 'unknown-option' },
      { path: ['pageIndex'], problem: 'unknown-option' },
    ],
    acceptedOptions: operationContracts.query.options,
  });
  expect(error.message).toBe(
    [
      'invalid-request in Customer.query:',
      '- pageSize: unknown option; use "limit" (integer 1–100).',
      '- pageIndex: unknown option; there is no offset or page-number paging; pass page.meta.continuationCursor from the previous page as "cursor", or iterate with for await.',
      'Accepted options: where, select, limit, cursor, evidence, stale, maxAgeMs, refresh, requireComplete, timeoutMs.',
    ].join('\n'),
  );

  await relate.close();
});

it('reports every invalid value at once, including reference filters', async () => {
  const { relate, ana } = createInvoiceApp();
  const error = await readError(() =>
    relate.as(ana).objects.Invoice.query({
      limit: 500,
      where: { customer: 42 },
    } as never),
  );

  expect(error.issues).toEqual([
    {
      path: ['limit'],
      problem: 'invalid-value',
      message: 'expected integer 1–100; got number 500.',
    },
    {
      path: ['where', 'customer'],
      problem: 'invalid-value',
      message: 'expected Customer object ID; got number 42.',
    },
  ]);
  expect(error.acceptedOptions).toBeUndefined();

  await relate.close();
});

it('answers hidden and missing filter properties identically, listing only discoverable ones', async () => {
  const { relate, ana } = createInvoiceApp();
  const issue = async (where: Record<string, unknown>) =>
    (
      await readError(() =>
        relate.as(ana).objects.Customer.query({ where } as never),
      )
    ).issues[0];
  const forbidden = await issue({ revenue: 1 });
  const missing = await issue({ revenu: 1 });

  expect(forbidden).toEqual({
    path: ['where', 'revenue'],
    problem: 'unknown-property',
    message: 'not a filterable property of Customer for this reader.',
    accepted: ['id', 'name', 'portfolio'],
  });
  expect(missing).toEqual({ ...forbidden, path: ['where', 'revenu'] });

  await relate.close();
});

it('explains traversal call mistakes without querying records', async () => {
  const { relate, ana } = createInvoiceApp();
  const { Customer, Invoice } = relate.as(ana).objects;

  // Filters name the destination's properties and are checked before any read,
  // alongside every other issue in the call.
  expect(
    (
      await readError(() =>
        Customer.traverse.invoices(
          '' as never,
          {
            where: { portfolio: 'north', status: { gt: 'Open' } },
          } as never,
        ),
      )
    ).issues,
  ).toEqual([
    {
      path: ['id'],
      problem: 'invalid-value',
      message: 'expected a nonblank Customer object ID string; got string.',
    },
    {
      path: ['where', 'portfolio'],
      problem: 'unknown-property',
      message: 'not a filterable property of Invoice for this reader.',
      accepted: ['customer', 'id', 'status'],
    },
    {
      path: ['where', 'status', 'gt'],
      problem: 'invalid-value',
      message: 'unsupported filter operator for this property.',
      accepted: ['eq', 'in'],
    },
  ]);
  expect(
    (
      await readError(() =>
        Invoice.traverse.customer(
          'i1' as never,
          { where: { name: 'Northwind' } } as never,
        ),
      )
    ).issues,
  ).toEqual([
    {
      path: ['where'],
      problem: 'not-supported',
      message:
        'not accepted here; this operation returns a single record and does not page or filter.',
    },
  ]);
  expect(
    await readError(() =>
      Invoice.traverse.customer('i1' as never, { limit: 5 } as never),
    ),
  ).toMatchObject({
    operation: 'Invoice.traverse.customer',
    issues: [{ path: ['limit'], problem: 'not-supported' }],
  });
  expect(
    await readError(() => Customer.traverse.invoices('' as never)),
  ).toMatchObject({
    issues: [
      {
        path: ['id'],
        message: 'expected a nonblank Customer object ID string; got string.',
      },
    ],
  });

  await relate.close();
});

it('gives one cursor answer for foreign, altered and stale continuations', async () => {
  const { relate, ana, Customer, Invoice } = createInvoiceApp();

  await relate.host.adopt(Customer, 'c1');
  await relate.host.adopt(Invoice, 'i1');
  await relate.host.adopt(Invoice, 'i2');

  const consumer = relate.as(ana);
  const page = await consumer.objects.Invoice.query({ limit: 1 });
  const cursor = page.meta.continuationCursor!;

  for (const call of [
    () => consumer.objects.Invoice.query({ limit: 2, cursor }),
    () => consumer.objects.Invoice.query({ limit: 1, cursor: cursor + 'x' }),
  ])
    expect(await readError(call)).toMatchObject({
      operation: 'Invoice.query',
      issues: [{ path: ['cursor'], problem: 'invalid-cursor' }],
    });

  expect(
    (await consumer.objects.Invoice.query({ limit: 1, cursor })).data,
  ).toHaveLength(1);

  await relate.close();
});

it('rejects options that are not plain data with a named issue', async () => {
  const { relate, ana } = createInvoiceApp();

  expect(
    await readError(() =>
      relate
        .as(ana)
        .objects.Customer.query({ select: [() => 'name'] } as never),
    ),
  ).toMatchObject({
    operation: 'Customer.query',
    issues: [{ path: [], problem: 'invalid-value' }],
  });

  await relate.close();
});

it('rejects unknown get options instead of ignoring them', async () => {
  const { relate, ana } = createInvoiceApp();

  expect(
    await readError(() =>
      relate
        .as(ana)
        .objects.Customer.get('c1' as never, { fields: ['name'] } as never),
    ),
  ).toMatchObject({
    operation: 'Customer.get',
    issues: [
      {
        path: ['fields'],
        message:
          'unknown option; use "select" with an array of property names.',
      },
    ],
    acceptedOptions: operationContracts.get.options,
  });

  await relate.close();
});
