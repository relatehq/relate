import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  connect,
  defineAccess,
  defineApp,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { startApp } from '@relate/node';
import { stripe } from '@relate/connector-stripe';

const customers = defineSource({
  id: 'stripe.customers',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string().nullable() }),
});
const Customer = defineObject({
  id: 'billing.customer',
  label: 'Customer',
  membership: source(customers),
  properties: {
    id: objectId({ id: 'billing.customer.id' }),
    name: from(customers.fields.name, { id: 'billing.customer.name' }),
  },
});
const access = defineAccess({
  roles: ['reader'],
  fieldGroups: ['ordinary'],
  claims: {},
});
const graph = defineGraph({
  id: 'billing',
  objects: { Customer },
  access,
  policies: {
    Customer: { read: { gate: access.role('reader') } },
  },
});

test('Stripe executes authorized refreshes, denies revoked access/account changes, and observes explicit deletion', async () => {
  let now = 1_000;
  let name = 'Ada';
  let status = 200;
  let account = 'acct_one';
  let deleted = false;
  const transport: typeof fetch = async (url) =>
    String(url).endsWith('/account')
      ? Response.json({ id: account, object: 'account' })
      : Response.json(
          deleted
            ? { id: 'cus_one', object: 'customer', deleted: true }
            : { id: 'cus_one', object: 'customer', livemode: false, name },
          { status },
        );
  const app = await startApp(
    defineApp({
      graph,
      setup: () => ({
        graphId: 'stripe-read-test',
        clock: () => now,
        connections: [
          connect(customers, {
            connectionId: 'stripe',
            providerAccountId: 'acct_one:test',
            connector: stripe({
              apiKey: 'sk_test_fixture',
              apiVersion: '2025-06-30.basil',
              mode: 'test',
              fetch: transport,
            }).resource('customers', { fields: ['name'] }),
          }),
        ],
      }),
    }),
  );

  try {
    const id = await app.host.adopt(Customer, 'cus_one');
    const reader = app.as({ id: 'reader', roles: ['reader'], claims: {} })
      .objects.Customer;

    expect(await reader.get(id)).toMatchObject({
      status: 'ok',
      data: { name: 'Ada' },
    });
    expect(
      await app
        .as({ id: 'outsider', roles: [], claims: {} })
        .objects.Customer.get(id),
    ).toMatchObject({ status: 'not-found' });
    now++;
    name = 'Ada Updated';
    expect(await reader.get(id, { maxAgeMs: 0, stale: 'allow' })).toMatchObject(
      {
        status: 'ok',
        data: { name },
      },
    );
    now++;
    status = 403;
    expect(await reader.get(id, { maxAgeMs: 0, stale: 'allow' })).toMatchObject(
      {
        status: 'not-found',
      },
    );
    now++;
    status = 200;
    account = 'acct_other';
    expect(await reader.get(id, { maxAgeMs: 0, stale: 'allow' })).toMatchObject(
      {
        status: 'not-found',
      },
    );
    now++;
    account = 'acct_one';
    expect(await reader.get(id, { maxAgeMs: 0, stale: 'allow' })).toMatchObject(
      {
        status: 'ok',
      },
    );
    now++;
    deleted = true;
    expect(await reader.get(id, { maxAgeMs: 0, stale: 'allow' })).toMatchObject(
      {
        status: 'not-found',
      },
    );
  } finally {
    await app.close();
  }
});
