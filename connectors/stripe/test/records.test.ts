import { expect, test, vi } from 'vitest';
import { stripe, StripeSourceError } from '@relate/connector-stripe';
import { SourceAccessDenied } from 'relate/connectors';
import { account, customer, fakeStripe, options, signal } from './fixture.js';

test('projects selected fields and does not fabricate a version', async () => {
  const f = fakeStripe();

  expect(await f.resource.fetch('cus_one', { signal: signal() })).toEqual({
    state: 'present',
    providerAccountId: 'acct_one:test',
    record: { id: 'cus_one', name: 'Ada', metadata: { portfolio: 'north' } },
  });
});

test('leaves out selected fields Stripe did not return; explicit nulls stay null', async () => {
  const f = fakeStripe();
  const resource = f.connection.resource('customers', {
    fields: ['name', 'email', 'subscriptions'],
  });

  f.respond({ ...customer, email: null });
  expect(await resource.fetch('cus_one', { signal: signal() })).toMatchObject({
    record: { id: 'cus_one', name: 'Ada', email: null },
  });
});

test.each([
  ['invoices', 'in_one', 'invoice'],
  ['subscriptions', 'sub_one', 'subscription'],
  ['products', 'prod_one', 'product'],
  ['prices', 'price_one', 'price'],
  ['payment_intents', 'pi_one', 'payment_intent'],
  ['charges', 'ch_one', 'charge'],
] as const)(
  'reads %s with validated object identity',
  async (name, id, object) => {
    const f = fakeStripe();

    f.respond({ id, object, livemode: false });
    expect(
      await f.connection
        .resource(name, { fields: [] })
        .fetch(id, { signal: signal() }),
    ).toMatchObject({ state: 'present', record: { id } });
    expect(f.calls.at(-1)!.url).toBe(`https://api.stripe.com/v1/${name}/${id}`);
  },
);

test.each([
  ['products', 'gold-plan', 'product'],
  ['products', 'gold plan?#%', 'product'],
  ['prices', 'plan_legacy', 'price'],
  ['prices', 'gold', 'price'],
  ['charges', 'py_legacy', 'charge'],
] as const)('reads opaque %s IDs: %s', async (name, id, object) => {
  const f = fakeStripe();

  f.respond({ id, object, livemode: false });
  expect(
    await f.connection
      .resource(name, { fields: [] })
      .fetch(id, { signal: signal() }),
  ).toMatchObject({ state: 'present', record: { id } });
  expect(f.urls()).toContain(
    `https://api.stripe.com/v1/${name}/${encodeURIComponent(id)}`,
  );
});

test.each([
  '',
  '.',
  '..',
  'gold/plan',
  'gold\\plan',
  'gold\nplan',
  'cus_one/../../account',
])('rejects unsafe path segment %j before sending credentials', async (id) => {
  const fetch = vi.fn();
  const resource = stripe({ ...options, fetch }).resource('products', {
    fields: [],
  });

  await expect(resource.fetch(id, { signal: signal() })).rejects.toThrow(
    'Invalid Stripe resource ID',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test('only affirmative tombstones establish deletion; missing resources remain errors', async () => {
  const f = fakeStripe();

  f.respond({ id: 'cus_one', object: 'customer', deleted: true });
  expect(await f.resource.fetch('cus_one', { signal: signal() })).toEqual({
    state: 'deleted',
    providerAccountId: 'acct_one:test',
  });
  f.respond({ error: { code: 'resource_missing', message: 'private' } }, 404);
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toMatchObject({
    status: 404,
    message: 'Stripe source request failed (HTTP 404)',
  });
});

test.each(['test', 'live'] as const)(
  'tombstones inherit verified %s key context and reject contradictory mode',
  async (mode) => {
    let body: object = { id: 'cus_one', object: 'customer', deleted: true };
    const resource = stripe({
      ...options,
      mode,
      apiKey: `sk_${mode}_fixture`,
      fetch: async (url) =>
        Response.json(String(url).endsWith('/account') ? account : body),
    }).resource('customers', { fields: [] });

    expect(await resource.fetch('cus_one', { signal: signal() })).toEqual({
      state: 'deleted',
      providerAccountId: `acct_one:${mode}`,
    });
    body = { ...body, livemode: mode !== 'live' };
    await expect(
      resource.fetch('cus_one', { signal: signal() }),
    ).rejects.toBeInstanceOf(SourceAccessDenied);
  },
);

test.each([401, 403])('maps HTTP %s to denial', async (status) => {
  const f = fakeStripe();

  f.respond({}, status);
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
});

test.each([429, 500, 503])(
  'keeps HTTP %s as failure without provider messages',
  async (status) => {
    const f = fakeStripe();

    f.respond({ error: { message: 'secret' } }, status);
    await expect(
      f.resource.fetch('cus_one', { signal: signal() }),
    ).rejects.toEqual(new StripeSourceError(status));
  },
);

test.each([
  { ...customer, id: 'cus_other' },
  { ...customer, object: 'invoice' },
  [],
  null,
])('rejects malformed or mismatched records', async (body) => {
  const f = fakeStripe();

  f.respond(body);
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(StripeSourceError);
});

test.each(['1e400', '9007199254740992'])(
  'rejects %s inside selected fields',
  async (value) => {
    const resource = stripe({
      ...options,
      fetch: async (url) =>
        String(url).endsWith('/account')
          ? Response.json(account)
          : new Response(
              `{"id":"cus_one","object":"customer","livemode":false,"metadata":{"number":${value}}}`,
            ),
    }).resource('customers', { fields: ['metadata'] });

    await expect(
      resource.fetch('cus_one', { signal: signal() }),
    ).rejects.toBeInstanceOf(StripeSourceError);
  },
);
