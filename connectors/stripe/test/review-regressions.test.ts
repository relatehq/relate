import { expect, test, vi } from 'vitest';
import { stripe, StripeSourceError } from '@relate/connector-stripe';
import { SourceAccessDenied } from 'relate/connectors';

const account = { id: 'acct_one', object: 'account' };
const customer = { id: 'cus_one', object: 'customer', livemode: false };
const options = {
  apiKey: 'sk_test_fixture',
  apiVersion: '2025-06-30.basil',
  mode: 'test' as const,
};
const signal = () => new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

test.each([
  ['products', 'gold-plan', 'product'],
  ['products', 'gold plan?#%', 'product'],
  ['prices', 'plan_legacy', 'price'],
  ['prices', 'gold', 'price'],
  ['charges', 'py_legacy', 'charge'],
] as const)('reads opaque %s IDs: %s', async (name, id, object) => {
  const urls: string[] = [];
  const resource = stripe({
    ...options,
    fetch: async (url) => {
      urls.push(String(url));

      return Response.json(
        String(url).endsWith('/account')
          ? account
          : { id, object, livemode: false },
      );
    },
  }).resource(name, { fields: [] });

  expect(await resource.fetch(id, { signal: signal() })).toMatchObject({
    state: 'present',
    record: { id },
  });
  expect(urls).toContain(
    `https://api.stripe.com/v1/${name}/${encodeURIComponent(id)}`,
  );
});

test.each(['', '.', '..', 'gold/plan', 'gold\\plan', 'gold\nplan'])(
  'rejects unsafe path segment %j without HTTP',
  async (id) => {
    const fetch = vi.fn();
    const resource = stripe({ ...options, fetch }).resource('products', {
      fields: [],
    });

    await expect(resource.fetch(id, { signal: signal() })).rejects.toThrow(
      'Invalid Stripe resource ID',
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

  expect(urls).toHaveLength(2);
  await Promise.resolve();
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

test.each(['success', 'failure', 'caller-abort', 'timeout'] as const)(
  'clears timers and caller listeners after %s',
  async (outcome) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removed = vi.spyOn(caller.signal, 'removeEventListener');

    try {
      const resource = stripe({
        ...options,
        timeoutMs: 100,
        fetch: async () => {
          if (outcome === 'success') return Response.json(account);

          if (outcome === 'failure') throw new Error('offline');

          return new Promise(() => {});
        },
      }).resource('customers', { fields: [] });
      const pending = resource.identify({ signal: caller.signal });

      expect(vi.getTimerCount()).toBe(1);
      const assertion =
        outcome === 'success'
          ? expect(pending).resolves.toBe('acct_one:test')
          : expect(pending).rejects.toBeInstanceOf(
              outcome === 'failure' ? StripeSourceError : DOMException,
            );

      if (outcome === 'caller-abort') caller.abort();

      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(100);

      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      vi.useRealTimers();
      removed.mockRestore();
    }
  },
);

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
