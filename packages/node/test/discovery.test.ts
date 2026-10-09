import { expect, it } from 'vitest';
import { connect } from 'relate';
import { createRuntime } from '@relate/node';
import {
  AccountReview,
  AddAccountReview,
  Customer,
  addAccountReview,
  ana,
  customers,
  graph,
  invoices,
} from '../../../tests/support/native-action-model.js';

const connector = () => ({
  identify: async () => 'test-account',
  fetch: async () => ({
    providerAccountId: 'test-account' as const,
    state: 'deleted' as const,
  }),
});

it('exposes progressive discovery on the typed consumer handle', async () => {
  const relate = createRuntime({
    graph,
    connections: [
      connect(customers, {
        connectionId: 'crm',
        providerAccountId: 'test-account',
        connector: connector(),
      }),
      connect(invoices, {
        connectionId: 'billing',
        providerAccountId: 'test-account',
        connector: connector(),
      }),
    ],
    actionImplementations: [addAccountReview],
  });
  const consumer = relate.as(ana);

  expect(consumer.describe()).toMatchObject({
    definitionId: 'native-action',
    description: 'Customer accounts, invoices, and account reviews.',
  });
  expect(consumer.objects.Customer.describe()).toMatchObject({
    definitionId: Customer.id,
    apiName: 'Customer',
  });
  expect(consumer.actions.addAccountReview.describe()).toMatchObject({
    definitionId: AddAccountReview.id,
    creates: [{ definitionId: AccountReview.id }],
  });

  await relate.close();
  expect(() => consumer.describe()).toThrow('closed');
  expect(() => consumer.objects.Customer.describe()).toThrow('closed');
  expect(() => consumer.actions.addAccountReview.describe()).toThrow('closed');
});
