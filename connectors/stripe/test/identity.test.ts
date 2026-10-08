import { expect, test, vi } from 'vitest';
import { stripe, StripeSourceError } from '@relate/connector-stripe';
import { SourceAccessDenied } from 'relate/connectors';
import {
  account,
  customer,
  deferred,
  fakeStripe,
  options,
  signal,
} from './fixture.js';

const ACCOUNT = 'https://api.stripe.com/v1/account';
const CUSTOMER = 'https://api.stripe.com/v1/customers/cus_one';

test('identify always asks Stripe; fetch reuses the scope verified for the same key', async () => {
  const f = fakeStripe();

  expect(await f.resource.identify({ signal: signal() })).toBe('acct_one:test');
  expect(await f.resource.fetch('cus_one', { signal: signal() })).toMatchObject(
    { providerAccountId: 'acct_one:test' },
  );
  expect(await f.resource.fetch('cus_one', { signal: signal() })).toMatchObject(
    { providerAccountId: 'acct_one:test' },
  );
  expect(f.urls()).toEqual([ACCOUNT, CUSTOMER, CUSTOMER]);
  expect(f.calls[0]!.headers.get('Stripe-Version')).toBe('2025-06-30.basil');

  f.setAccount('acct_two');
  expect(await f.resource.identify({ signal: signal() })).toBe('acct_two:test');
  expect(await f.resource.fetch('cus_one', { signal: signal() })).toMatchObject(
    { providerAccountId: 'acct_two:test' },
  );
});

test('a record denial forgets the verified scope, so the next fetch verifies again', async () => {
  const f = fakeStripe();

  await f.resource.fetch('cus_one', { signal: signal() });
  f.respond({}, 401);
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
  f.respond(customer);
  await f.resource.fetch('cus_one', { signal: signal() });
  expect(f.urls()).toEqual([ACCOUNT, CUSTOMER, CUSTOMER, ACCOUNT, CUSTOMER]);
});

test('distinguishes live scope from test scope for the same account', async () => {
  const f = fakeStripe({ apiKey: 'rk_live_fixture', mode: 'live' });

  f.respond({ ...customer, livemode: true });
  const live = f.connection.resource('customers', { fields: ['name'] });

  expect(await live.identify({ signal: signal() })).toBe('acct_one:live');
  expect(await live.fetch('cus_one', { signal: signal() })).toMatchObject({
    providerAccountId: 'acct_one:live',
    state: 'present',
  });
});

test('denies a record whose livemode contradicts the key', async () => {
  const f = fakeStripe();

  f.respond({ ...customer, livemode: true });
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
});

test('verifies the Connect account rather than trusting configuration', async () => {
  const f = fakeStripe({ account: 'acct_one' });
  const connected = f.connection.resource('customers', { fields: [] });

  expect(await connected.identify({ signal: signal() })).toBe('acct_one:test');
  expect(f.calls.at(-1)!.headers.get('Stripe-Account')).toBe('acct_one');
  f.setAccount('acct_other');
  await expect(connected.identify({ signal: signal() })).rejects.toBeInstanceOf(
    SourceAccessDenied,
  );
  // The failed verification is not replaced by an earlier cached scope.
  await expect(
    connected.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
});

test('resolves rotating credentials once per operation and verifies each new key', async () => {
  const f = fakeStripe();
  let key = 'sk_test_first';
  const credentials = vi.fn(() => key);
  const resource = stripe({
    ...options,
    apiKey: credentials,
    fetch: f.transport,
  }).resource('customers', { fields: [] });

  await resource.fetch('cus_one', { signal: signal() });
  key = 'sk_test_second';
  await resource.fetch('cus_one', { signal: signal() });
  expect(credentials).toHaveBeenCalledTimes(2);
  expect(f.calls.map((c) => [c.url, c.headers.get('Authorization')])).toEqual([
    [ACCOUNT, 'Bearer sk_test_first'],
    [CUSTOMER, 'Bearer sk_test_first'],
    [ACCOUNT, 'Bearer sk_test_second'],
    [CUSTOMER, 'Bearer sk_test_second'],
  ]);
});

test.each([
  ['wrong mode', 'sk_live_wrong'],
  ['trailing newline', 'sk_test_fixture\n'],
  ['missing', undefined],
])(
  'treats a %s key as misconfiguration, not denial, without HTTP',
  async (_, key) => {
    const fetch = vi.fn();
    const resource = stripe({
      ...options,
      apiKey: () => key as string,
      fetch,
    }).resource('customers', { fields: [] });
    const reading = resource.fetch('cus_one', { signal: signal() });

    await expect(reading).rejects.toBeInstanceOf(StripeSourceError);
    await expect(reading).rejects.toThrow(
      'Stripe apiKey must be an sk_test_ or rk_test_ key',
    );
    expect(fetch).not.toHaveBeenCalled();
  },
);

test('starts both requests before identity resolves but does not release unverified data', async () => {
  const identity = deferred<Response>();
  const urls: string[] = [];
  const resource = stripe({
    ...options,
    fetch: async (url) => {
      urls.push(String(url));

      return String(url).endsWith('/account')
        ? identity.promise
        : Response.json(customer);
    },
  }).resource('customers', { fields: [] });
  let settled = false;
  const pending = resource
    .fetch('cus_one', { signal: signal() })
    .finally(() => {
      settled = true;
    });

  await vi.waitFor(() => expect(urls).toHaveLength(2));
  expect(settled).toBe(false);
  identity.resolve(Response.json(account));
  expect(await pending).toMatchObject({
    state: 'present',
    providerAccountId: 'acct_one:test',
  });
});

test.each(['identity', 'resource'])(
  'a delayed %s denial wins over a fast outage',
  async (denied) => {
    const denial = deferred<Response>();
    const resource = stripe({
      ...options,
      fetch: async (url) => {
        const identity = String(url).endsWith('/account');

        return identity === (denied === 'identity')
          ? denial.promise
          : Response.json({}, { status: 503 });
      },
    }).resource('customers', { fields: [] });
    const pending = resource.fetch('cus_one', { signal: signal() });
    const assertion =
      expect(pending).rejects.toBeInstanceOf(SourceAccessDenied);

    await Promise.resolve();
    denial.resolve(Response.json({}, { status: 403 }));
    await assertion;
  },
);

test.each(['identity', 'resource'])(
  'a %s denial promptly cancels a stalled sibling',
  async (denied) => {
    let siblingSignal: AbortSignal | undefined;
    const resource = stripe({
      ...options,
      fetch: async (url, init) => {
        if (String(url).endsWith('/account') === (denied === 'identity'))
          return Response.json({}, { status: 403 });

        siblingSignal = init?.signal ?? undefined;

        return new Promise((_, reject) =>
          siblingSignal!.addEventListener(
            'abort',
            () => reject(siblingSignal!.reason),
            { once: true },
          ),
        );
      },
    }).resource('customers', { fields: [] });

    await expect(
      resource.fetch('cus_one', { signal: signal() }),
    ).rejects.toBeInstanceOf(SourceAccessDenied);
    expect(siblingSignal?.aborted).toBe(true);
  },
);
