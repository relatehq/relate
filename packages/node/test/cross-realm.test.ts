import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { bind, implementAction } from 'relate';
import { createRuntime } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import {
  graph,
  AddAccountReview,
  Customer,
  customers,
  invoices,
  ana,
  addAccountReview,
} from '../../../tests/support/native-action-model.js';

/**
 * Agent REPLs and other sandboxes run caller code in a separate JavaScript
 * realm (`node:vm` context), so their object literals have a different
 * Object.prototype. They must be accepted exactly like host objects.
 */
const fromSandbox = <T>(value: T): T =>
  runInNewContext(`(${JSON.stringify(value)})`) as T;

function createSandboxRuntime(options: { sandboxRecords?: boolean } = {}) {
  const record = (id: string) => {
    const value = { id, name: 'Mothlight', portfolio: 'north' };

    return options.sandboxRecords ? fromSandbox(value) : value;
  };

  return createRuntime({
    graph,
    graphId: randomUUID(),
    store: createMemoryStore(),
    actionImplementations: [
      implementAction(graph, AddAccountReview, addAccountReview.implementation),
    ],
    bindings: [
      bind(customers, {
        providerAccountId: 'example-account',
        connectionId: 'crm',
        resourceId: 'records',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: record(id),
          }),
        },
      }),
      bind(invoices, {
        providerAccountId: 'example-account',
        connectionId: 'billing',
        resourceId: 'records',
        connector: {
          identify: async () => 'example-account',
          fetch: async (id) => ({
            providerAccountId: 'example-account',
            state: 'present',
            record: { id },
          }),
        },
      }),
    ],
  });
}

it('invokes an action with input built in another realm', async () => {
  const relate = createSandboxRuntime();
  const customer = await relate.host.adopt(Customer, 'mothlight');

  const receipt = await relate.as(ana).actions.addAccountReview({
    input: fromSandbox({ customer, note: 'Follow up' }),
    idempotencyKey: 'review',
  });

  expect(receipt).toMatchObject({ state: 'succeeded' });
  await relate.close();
});

it('still rejects action input that is a class instance', async () => {
  const relate = createSandboxRuntime();
  const customer = await relate.host.adopt(Customer, 'mothlight');
  const input = runInNewContext(
    'new (class Input { constructor(c) { this.customer = c; this.note = "n"; } })(customer)',
    { customer },
  ) as { customer: typeof customer; note: string };

  await expect(
    relate
      .as(ana)
      .actions.addAccountReview({ input, idempotencyKey: 'review' }),
  ).rejects.toMatchObject({ code: 'invalid' });
  await relate.close();
});

it('reads a source record a connector built in another realm', async () => {
  const relate = createSandboxRuntime({ sandboxRecords: true });
  const customer = await relate.host.adopt(Customer, 'mothlight');

  expect(
    await relate.as(ana).objects.Customer.get(customer, { select: ['name'] }),
  ).toMatchObject({ status: 'ok', data: { name: 'Mothlight' } });
  await relate.close();
});
