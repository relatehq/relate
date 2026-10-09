import { expect, it } from 'vitest';
import {
  defineGraph,
  defineObject,
  defineRelationship,
  reference,
} from 'relate';
import { compile } from 'relate/compiler';
import { ReadError } from '@relate/protocol';
import { createRuntime } from '@relate/runtime';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

/** Invoice→Customer links are financial, so employees cannot traverse them. */
function createRestrictedRuntime() {
  const model = createInvoiceGraph();
  const Invoice = defineObject({
    ...model.Invoice,
    properties: {
      ...model.Invoice.properties,
      customer: reference(model.Customer, {
        id: 'invoice.customer',
        access: model.access.groups.financial,
        from: model.invoices.fields.customer_id,
      }),
    },
  });
  const graph = defineGraph({
    ...model.graph,
    objects: { Customer: model.Customer, Invoice },
    relationships: {
      CustomerInvoices: defineRelationship({
        id: model.CustomerInvoices.id,
        forward: 'invoices',
        reverse: 'customer',
        via: Invoice.properties.customer,
      }),
    },
  });
  // Validation precedes every source read; this connector is never reached.
  const binding = {
    providerAccountId: 'account',
    connectionId: 'test',
    authorization: 'shared-service' as const,
    connector: {
      identify: async () => 'account',
      fetch: async () => {
        throw new Error('Request errors must not read sources');
      },
    },
  };
  const runtime = createRuntime({
    model: compile(graph),
    graphId: 'request-errors',
    sources: {
      [model.customers.id]: binding,
      [model.invoices.id]: binding,
    },
  });

  return { ...model, Invoice, runtime };
}

async function readError(operation: () => Promise<unknown>) {
  const error = await operation().then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(error).toBeInstanceOf(ReadError);

  return error as ReadError;
}

it('answers role-hidden and missing traversals identically, before checking options or IDs', async () => {
  const { runtime, ana, finance, Invoice } = createRestrictedRuntime();
  const attempt = (name: string) =>
    readError(() => runtime.traverse(ana, Invoice.id, '', name, { limit: 5 }));
  const hidden = await attempt('customer');
  const missing = await attempt('customr');
  const neutral = (error: ReadError) =>
    JSON.parse(
      JSON.stringify({
        operation: error.operation,
        issues: error.issues,
        message: error.message,
      }).replaceAll(/customr|customer/g, '<name>'),
    );

  // No cardinality-specific `limit` issue and no ID issue: nothing about the
  // hidden traversal is checked before the neutral answer.
  expect(hidden.issues).toEqual([
    {
      path: [],
      problem: 'unknown-traversal',
      message: '"customer" is not an available traversal from this object.',
      accepted: [],
    },
  ]);
  expect(neutral(hidden)).toEqual(neutral(missing));

  // The reader who may use it gets the operation-specific issues instead.
  expect(
    (
      await readError(() =>
        runtime.traverse(finance, Invoice.id, '', 'customer', { limit: 5 }),
      )
    ).issues.map((issue) => [issue.path, issue.problem]),
  ).toEqual([
    [['id'], 'invalid-value'],
    [['limit'], 'not-supported'],
  ]);
});

it('names object types in errors only when the reader may read them', async () => {
  const { runtime, ana, Customer } = createRestrictedRuntime();
  const outsider = { id: 'outsider', roles: [], claims: {} };
  const calls = (principal: typeof ana | typeof outsider) => [
    () => runtime.query(principal, Customer.id, { pageSize: 1 } as never),
    () => runtime.read(principal, Customer.id, 'c1', { fields: [] } as never),
    () => runtime.traverse(principal, Customer.id, 'c1', 'invoice'),
  ];

  for (const call of calls(outsider)) {
    const error = await readError(call);

    expect(error.operation).toMatch(/^business\.customer\./);
    expect(
      JSON.stringify({ message: error.message, issues: error.issues }),
    ).not.toMatch(/Customer|Invoice|invoices/);
  }

  expect(
    await Promise.all(
      calls(ana).map(async (call) => (await readError(call)).operation),
    ),
  ).toEqual(['Customer.query', 'Customer.get', 'Customer.traverse.invoice']);
});
