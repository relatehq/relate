import { expect, test, vi } from 'vitest';
import { stripe, StripeSourceError } from '@relate/connector-stripe';
import { SourceAccessDenied } from 'relate/connectors';

const signal = () => new AbortController().signal;
const customer = {
  id: 'cus_one',
  object: 'customer',
  livemode: false,
  name: 'Ada',
  email: 'private@example.com',
  metadata: { portfolio: 'north' },
};

function fixture() {
  let account = 'acct_one';
  let body: unknown = customer;
  let status = 200;
  const calls: { url: string; headers: Headers }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe('error');

    return String(url).endsWith('/account')
      ? Response.json({ id: account, object: 'account' })
      : Response.json(body, { status });
  };
  const connection = stripe({
    apiKey: 'rk_test_fixture',
    apiVersion: '2025-06-30.basil',
    mode: 'test',
    fetch: transport,
  });

  return {
    connection,
    transport,
    calls,
    resource: connection.resource('customers', {
      fields: ['name', 'metadata'],
    }),
    setAccount: (value: string) => {
      account = value;
    },
    respond: (value: unknown, code = 200) => {
      body = value;
      status = code;
    },
  };
}

test('verifies identity on every read, projects fields, and does not fabricate a version', async () => {
  const f = fixture();

  expect(await f.resource.identify({ signal: signal() })).toBe('acct_one:test');
  expect(await f.resource.fetch('cus_one', { signal: signal() })).toEqual({
    state: 'present',
    providerAccountId: 'acct_one:test',
    record: { id: 'cus_one', name: 'Ada', metadata: { portfolio: 'north' } },
  });
  f.setAccount('acct_two');
  expect(await f.resource.fetch('cus_one', { signal: signal() })).toMatchObject(
    { providerAccountId: 'acct_two:test' },
  );
  expect(f.calls.map((c) => c.url)).toEqual([
    'https://api.stripe.com/v1/account',
    'https://api.stripe.com/v1/account',
    'https://api.stripe.com/v1/customers/cus_one',
    'https://api.stripe.com/v1/account',
    'https://api.stripe.com/v1/customers/cus_one',
  ]);
  expect(f.calls[0]!.headers.get('Stripe-Version')).toBe('2025-06-30.basil');
});

test('only affirmative tombstones establish deletion; missing resources remain errors', async () => {
  const f = fixture();

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

test.each([401, 403])('maps HTTP %s to denial', async (status) => {
  const f = fixture();

  f.respond({}, status);
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
});

test.each([429, 500, 503])(
  'keeps HTTP %s as failure without provider messages',
  async (status) => {
    const f = fixture();

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
  { id: 'cus_one', object: 'customer', livemode: false },
])(
  'rejects malformed/mismatched records and absent selected fields',
  async (body) => {
    const f = fixture();

    f.respond(body);
    await expect(
      f.resource.fetch('cus_one', { signal: signal() }),
    ).rejects.toBeInstanceOf(StripeSourceError);
  },
);

test('denies mismatched livemode and verifies Connect account', async () => {
  const f = fixture();

  f.respond({ ...customer, livemode: true });
  await expect(
    f.resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
  const connected = stripe({
    apiKey: 'sk_test_fixture',
    mode: 'test',
    apiVersion: '2025-06-30.basil',
    account: 'acct_one',
    fetch: f.transport,
  }).resource('customers', { fields: [] });

  expect(await connected.identify({ signal: signal() })).toBe('acct_one:test');
  expect(f.calls.at(-1)!.headers.get('Stripe-Account')).toBe('acct_one');
  f.setAccount('acct_other');
  await expect(
    connected.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
});

test('snapshots rotating credentials for identity and data; rejects wrong mode before HTTP', async () => {
  const f = fixture();
  let key = 'sk_test_first';
  const credentials = vi.fn(() => key);
  const resource = stripe({
    apiKey: credentials,
    mode: 'test',
    apiVersion: '2025-06-30.basil',
    fetch: f.transport,
  }).resource('customers', { fields: [] });

  await resource.fetch('cus_one', { signal: signal() });
  key = 'sk_test_second';
  await resource.fetch('cus_one', { signal: signal() });
  expect(credentials).toHaveBeenCalledTimes(2);
  expect(f.calls.map((c) => c.headers.get('Authorization'))).toEqual([
    'Bearer sk_test_first',
    'Bearer sk_test_first',
    'Bearer sk_test_second',
    'Bearer sk_test_second',
  ]);
  key = 'sk_live_wrong';
  await expect(
    resource.fetch('cus_one', { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
  expect(f.calls).toHaveLength(4);
});

test('aborts before requests and during credential resolution; enforces operation timeout', async () => {
  const f = fixture();
  const controller = new AbortController();

  controller.abort();
  await expect(
    f.resource.identify({ signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.calls).toHaveLength(0);
  const waiting = stripe({
    apiKey: () => new Promise(() => {}),
    mode: 'test',
    apiVersion: '2025-06-30.basil',
    timeoutMs: 20,
    fetch: f.transport,
  }).resource('customers', { fields: [] });

  await expect(waiting.identify({ signal: signal() })).rejects.toMatchObject({
    name: 'TimeoutError',
  });
  const active = new AbortController();
  const pending = waiting.identify({ signal: active.signal });

  active.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

test('rejects oversized/invalid responses and sanitizes transport exceptions', async () => {
  for (const transport of [
    async () => new Response('x'.repeat(128)),
    async () => new Response('{bad'),
    async () => {
      throw new Error('sk_test_secret');
    },
  ]) {
    const resource = stripe({
      apiKey: 'sk_test_fixture',
      apiVersion: '2025-06-30.basil',
      mode: 'test',
      maxResponseBytes: 64,
      fetch: transport,
    }).resource('customers', { fields: [] });

    await expect(resource.identify({ signal: signal() })).rejects.toEqual(
      new StripeSourceError(),
    );
  }
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
    const f = fixture();

    f.respond({ id, object, livemode: false });
    expect(
      await f.connection
        .resource(name, { fields: [] })
        .fetch(id, { signal: signal() }),
    ).toMatchObject({ state: 'present', record: { id } });
    expect(f.calls.at(-1)!.url).toBe(`https://api.stripe.com/v1/${name}/${id}`);
  },
);

test('rejects path injection before sending credentials', async () => {
  const f = fixture();

  await expect(
    f.resource.fetch('cus_one/../../account', { signal: signal() }),
  ).rejects.toThrow('Invalid Stripe resource ID');
  expect(f.calls).toHaveLength(0);
});

test('distinguishes live scope from test scope for the same account', async () => {
  const f = fixture();

  f.respond({ ...customer, livemode: true });
  const live = stripe({
    apiKey: 'rk_live_fixture',
    apiVersion: '2025-06-30.basil',
    mode: 'live',
    fetch: f.transport,
  }).resource('customers', { fields: ['name'] });

  expect(await live.identify({ signal: signal() })).toBe('acct_one:live');
  expect(await live.fetch('cus_one', { signal: signal() })).toMatchObject({
    providerAccountId: 'acct_one:live',
    state: 'present',
  });
});

test('cancellation reaches active HTTP and late credentials cannot start a request', async () => {
  let receivedSignal: AbortSignal | undefined;
  const transport: typeof fetch = async (_, init) => {
    receivedSignal = init?.signal ?? undefined;

    return new Promise((_, reject) =>
      receivedSignal!.addEventListener(
        'abort',
        () => reject(receivedSignal!.reason),
        { once: true },
      ),
    );
  };
  const resource = stripe({
    apiKey: 'sk_test_fixture',
    apiVersion: '2025-06-30.basil',
    mode: 'test',
    fetch: transport,
  }).resource('customers', { fields: [] });
  const controller = new AbortController();
  const pending = resource.identify({ signal: controller.signal });

  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(receivedSignal?.aborted).toBe(true);

  let resolveKey!: (key: string) => void;
  const f = fixture();
  const late = stripe({
    apiKey: () =>
      new Promise((resolve) => {
        resolveKey = resolve;
      }),
    apiVersion: '2025-06-30.basil',
    mode: 'test',
    fetch: f.transport,
  }).resource('customers', { fields: [] });
  const cancelled = new AbortController();
  const reading = late.identify({ signal: cancelled.signal });

  cancelled.abort();
  await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  resolveKey('sk_test_fixture');
  await Promise.resolve();
  expect(f.calls).toHaveLength(0);
});

test('rejects nonfinite and unsafe integers inside selected fields', async () => {
  for (const value of ['1e400', '9007199254740992']) {
    const resource = stripe({
      apiKey: 'sk_test_fixture',
      apiVersion: '2025-06-30.basil',
      mode: 'test',
      fetch: async (url) =>
        String(url).endsWith('/account')
          ? Response.json({ id: 'acct_one', object: 'account' })
          : new Response(
              `{"id":"cus_one","object":"customer","livemode":false,"metadata":{"number":${value}}}`,
            ),
    }).resource('customers', { fields: ['metadata'] });

    await expect(
      resource.fetch('cus_one', { signal: signal() }),
    ).rejects.toBeInstanceOf(StripeSourceError);
  }
});
