import { expect, test, vi } from 'vitest';
import { stripe, StripeSourceError } from '@relate/connector-stripe';
import { account, fakeStripe, options, signal } from './fixture.js';

function hangingTransport() {
  const signals: AbortSignal[] = [];
  const transport: typeof fetch = async (_, init) => {
    const active = init!.signal!;

    signals.push(active);

    return new Promise((_, reject) =>
      active.addEventListener('abort', () => reject(active.reason), {
        once: true,
      }),
    );
  };

  return { signals, transport };
}

test('an already-aborted caller sends nothing', async () => {
  const f = fakeStripe();
  const controller = new AbortController();

  controller.abort();
  await expect(
    f.resource.identify({ signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.calls).toHaveLength(0);
});

test('caller cancellation reaches active HTTP and rejects with the caller reason', async () => {
  const { signals, transport } = hangingTransport();
  const resource = stripe({ ...options, fetch: transport }).resource(
    'customers',
    { fields: [] },
  );
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  const pending = resource.identify({ signal: controller.signal });

  await vi.waitFor(() => expect(signals).toHaveLength(1));
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(signals[0]!.aborted).toBe(true);
});

test('the connector deadline cancels HTTP and fails as StripeSourceError', async () => {
  const { signals, transport } = hangingTransport();
  const resource = stripe({
    ...options,
    timeoutMs: 20,
    fetch: transport,
  }).resource('customers', { fields: [] });
  const pending = resource.identify({ signal: signal() });

  await expect(pending).rejects.toBeInstanceOf(StripeSourceError);
  await expect(pending).rejects.toThrow('Stripe source request timed out');
  expect(signals[0]!.aborted).toBe(true);
});

test('the deadline also bounds a credential callback that never settles', async () => {
  const resource = stripe({
    ...options,
    apiKey: () => new Promise(() => {}),
    timeoutMs: 20,
    fetch: vi.fn(),
  }).resource('customers', { fields: [] });

  await expect(resource.identify({ signal: signal() })).rejects.toThrow(
    'Stripe source request timed out',
  );
});

test('credentials resolved after cancellation cannot start a request', async () => {
  const f = fakeStripe();
  let resolveKey!: (key: string) => void;
  const late = stripe({
    ...options,
    apiKey: () =>
      new Promise((resolve) => {
        resolveKey = resolve;
      }),
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

test.each([
  ['oversized', async () => new Response('x'.repeat(128))],
  ['invalid JSON', async () => new Response('{bad')],
  [
    'secret-bearing transport exception',
    async () => {
      throw new Error('sk_test_secret');
    },
  ],
])('fails a %s response with a sanitized error', async (_, transport) => {
  const resource = stripe({
    ...options,
    maxResponseBytes: 64,
    fetch: transport,
  }).resource('customers', { fields: [] });

  await expect(resource.identify({ signal: signal() })).rejects.toEqual(
    new StripeSourceError(),
  );
});

test.each(['complete', 'errored', 'oversize'] as const)(
  'releases stream lock after %s, even when cancellation rejects',
  async (state) => {
    const cancel = vi.fn(() => Promise.reject(new Error('cancel failed')));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (state === 'errored') controller.error(new Error('read failed'));
        else {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(account)));

          if (state === 'complete') controller.close();
        }
      },
      cancel,
    });
    const resource = stripe({
      ...options,
      maxResponseBytes: state === 'oversize' ? 1 : 1024,
      fetch: async () => new Response(stream),
    }).resource('customers', { fields: [] });

    if (state === 'complete')
      await expect(resource.identify({ signal: signal() })).resolves.toBe(
        'acct_one:test',
      );
    else
      await expect(
        resource.identify({ signal: signal() }),
      ).rejects.toBeInstanceOf(StripeSourceError);

    expect(stream.locked).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(state === 'oversize' ? 1 : 0);
  },
);
