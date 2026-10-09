import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import {
  graph,
  Customer,
  customers,
  invoices,
  ana,
} from '../../../tests/support/native-action-model.js';

// The typed @relate/node facade deep-clones query requests, which hides the
// realm; the runtime only copies the top level, so `where` keeps its realm here.
it('queries with a where filter built in another realm', async () => {
  const runtime = createRuntime({
    model: compile(graph),
    graphId: 'cross-realm',
    sources: {
      [customers.id]: {
        providerAccountId: 'example-account',
        connectionId: 'crm',
        authorization: 'shared-service',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: { id, name: 'Northwind', portfolio: 'north' },
          }),
        },
      },
      [invoices.id]: {
        providerAccountId: 'example-account',
        connectionId: 'billing',
        authorization: 'shared-service',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: { id },
          }),
        },
      },
    },
  });
  const customer = await runtime.adopt(Customer.id, 'northwind');

  const page = await runtime.query(ana, Customer.id, {
    where: runInNewContext('({ name: "Northwind" })'),
  });

  expect(page.data.map((item) => item.id)).toEqual([customer]);
});
