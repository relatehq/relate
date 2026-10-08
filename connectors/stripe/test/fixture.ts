import { expect } from 'vitest';
import { stripe } from '@relate/connector-stripe';
import type { StripeOptions } from '@relate/connector-stripe';

export const signal = () => new AbortController().signal;

export const options = {
  apiKey: 'sk_test_fixture',
  apiVersion: '2025-06-30.basil',
  mode: 'test',
} satisfies StripeOptions;

export const account = { id: 'acct_one', object: 'account' };

export const customer = {
  id: 'cus_one',
  object: 'customer',
  livemode: false,
  name: 'Ada',
  email: 'private@example.com',
  metadata: { portfolio: 'north' },
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/** Fake Stripe API: GET /v1/account plus one configurable record response. */
export function fakeStripe(overrides: Partial<StripeOptions> = {}) {
  let accountId = 'acct_one';
  let body: unknown = customer;
  let status = 200;
  const calls: { url: string; headers: Headers }[] = [];
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe('error');

    return String(url).endsWith('/account')
      ? Response.json({ id: accountId, object: 'account' })
      : Response.json(body, { status });
  };
  const connection = stripe({ ...options, fetch: transport, ...overrides });

  return {
    connection,
    transport,
    calls,
    urls: () => calls.map((call) => call.url),
    resource: connection.resource('customers', {
      fields: ['name', 'metadata'],
    }),
    setAccount: (value: string) => {
      accountId = value;
    },
    respond: (value: unknown, code = 200) => {
      body = value;
      status = code;
    },
  };
}
