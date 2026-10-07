import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import pg from 'pg';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createPostgresStore } from '@relate/postgres';
import { createRuntime } from '@relate/runtime';
import type { ActionHandler } from '@relate/runtime';
import type { ObservationStore } from '@relate/runtime/storage';
import {
  StorageUnavailable,
  NativeCommitUncertain,
} from '@relate/runtime/storage';
import { createNativePostgresStore } from '../../packages/postgres/src/native.js';
import { testDatabaseUrl } from '../support/database.js';
import {
  graph,
  AddAccountReview,
  AccountReview,
  Customer,
  customers,
  invoices,
  ana,
} from '../support/native-action-model.js';

const model = compile(graph);
let store: ReturnType<typeof createPostgresStore>;
let pool: pg.Pool;
let graphId: string;
const scope = () => ({ graphId, definitionRevision: model.definitionRevision });

beforeEach(async () => {
  graphId = randomUUID();
  store = createPostgresStore({ connectionString: testDatabaseUrl() });
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  await store.migrate();
});
afterEach(async () => {
  await Promise.all([store.close(), pool.end()]);
});

const createReview: ActionHandler = async (context) => {
  const review = await context.create(AccountReview.id, {
    customer: context.input.customer,
    author: context.actor.id,
    note: context.input.note,
  });

  return { reviewId: review.id };
};

function app(
  handler = createReview,
  storage: ObservationStore = store,
  actionTimeoutMs = 60_000,
) {
  return createRuntime({
    model,
    graphId,
    store: storage,
    actionTimeoutMs,
    sources: {
      [customers.id]: {
        connectionId: 'crm',
        authorization: 'shared-service',
        connector: {
          async fetch(id) {
            return {
              state: 'present',
              record: { id, name: 'Northwind', portfolio: 'north' },
            };
          },
        },
      },
      [invoices.id]: {
        connectionId: 'billing',
        authorization: 'shared-service',
        connector: {
          async fetch(id) {
            return { state: 'present', record: { id } };
          },
        },
      },
    },
    actionHandlers: { [AddAccountReview.id]: handler },
  });
}

function request(customer: string, idempotencyKey = 'review') {
  return {
    input: { customer, note: 'Availability regression' },
    idempotencyKey,
  };
}

async function expectEmpty() {
  for (const table of ['native_objects', 'native_invocations']) {
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM relate.${table} WHERE graph_id=$1`,
      [graphId],
    );

    expect(result.rows[0].count).toBe(0);
  }
}

it('allows queued actions across runtimes while a handler waits beyond the former lock, statement and idle limits', async () => {
  const secondStore = createPostgresStore({
    connectionString: testDatabaseUrl(),
  });
  let entered!: () => void;
  let resume!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const slow = app(async (context) => {
    const output = await createReview(context);

    entered();
    await resumed;

    return output;
  });
  const customer = await slow.adopt(Customer.id, 'northwind');
  const first = slow.invoke(
    ana,
    AddAccountReview.id,
    request(customer, 'first'),
  );
  // Attach rejection handlers immediately, including to the slow invocation.
  const firstResult = Promise.allSettled([first]);

  try {
    await Promise.race([ready, first]);
    const queued = app(createReview, secondStore);
    const results = Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        queued.invoke(
          ana,
          AddAccountReview.id,
          request(customer, `queued-${i}`),
        ),
      ),
    );

    await delay(5_500);
    resume();
    const settled = [...(await firstResult), ...(await results)];

    expect(settled.map((result) => result.status)).toEqual(
      Array(7).fill('fulfilled'),
    );

    for (const key of [
      'first',
      ...Array.from({ length: 6 }, (_, i) => `queued-${i}`),
    ])
      expect(
        (await store.native!.loadInvocation(scope(), AddAccountReview.id, key))
          ?.receipt.state,
      ).toBe('succeeded');
  } finally {
    resume();
    await firstResult;
    await secondStore.close();
  }
});

it('maps a real advisory lock timeout to unavailable and leaves the key retryable', async () => {
  const nativePool = new pg.Pool({
    connectionString: testDatabaseUrl(),
    lock_timeout: 50,
  });
  const blocked = app(createReview, {
    ...store,
    native: createNativePostgresStore(nativePool),
  });
  const customer = await blocked.adopt(Customer.id, 'northwind');
  const blocker = await pool.connect();

  try {
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['native', graphId])],
    );
    await expect(
      blocked.invoke(ana, AddAccountReview.id, request(customer)),
    ).rejects.toMatchObject({
      name: 'ActionError',
      code: 'unavailable',
      message: 'unavailable',
    });
    await expectEmpty();
    await blocker.query('ROLLBACK');
    await expect(
      blocked.invoke(ana, AddAccountReview.id, request(customer)),
    ).resolves.toMatchObject({ state: 'succeeded' });
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await nativePool.end();
  }
});

it('interrupts a never-returning handler when its session dies and releases the pool slot', async () => {
  const nativePool = new pg.Pool({
    connectionString: testDatabaseUrl(),
    max: 1,
    idle_in_transaction_session_timeout: 100,
  });
  const runtime = app(
    async (context) => {
      const output = await createReview(context);

      await new Promise<void>(() => {});

      return output;
    },
    { ...store, native: createNativePostgresStore(nativePool) },
  );

  try {
    const customer = await runtime.adopt(Customer.id, 'northwind');

    await expect(
      runtime.invoke(ana, AddAccountReview.id, request(customer)),
    ).rejects.toMatchObject({ name: 'ActionError', code: 'unavailable' });
    await expectEmpty();
    expect(nativePool.totalCount).toBe(0);
    const recovered = app(createReview, {
      ...store,
      native: createNativePostgresStore(nativePool),
    });

    await expect(
      recovered.invoke(ana, AddAccountReview.id, request(customer)),
    ).resolves.toMatchObject({ state: 'succeeded' });
  } finally {
    await nativePool.end();
  }
});

it('returns the pool slot and rolls back a never-returning handler at its execution deadline', async () => {
  const nativePool = new pg.Pool({
    connectionString: testDatabaseUrl(),
    max: 1,
  });
  const storage = { ...store, native: createNativePostgresStore(nativePool) };
  const runtime = app(
    async (context) => {
      await createReview(context);
      await new Promise<void>(() => {});
    },
    storage,
    500,
  );

  try {
    const customer = await runtime.adopt(Customer.id, 'northwind');

    await expect(
      runtime.invoke(ana, AddAccountReview.id, request(customer)),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expectEmpty();
    expect(nativePool.totalCount).toBe(1);
    expect(nativePool.idleCount).toBe(1);
    await expect(
      app(createReview, storage).invoke(
        ana,
        AddAccountReview.id,
        request(customer),
      ),
    ).resolves.toMatchObject({ state: 'succeeded' });
  } finally {
    await nativePool.end();
  }
});

it.each(['success', 'lost-ack'])(
  'preserves COMMIT %s when acknowledgement outlasts the execution budget',
  async (outcome) => {
    const nativePool = new pg.Pool({ connectionString: testDatabaseUrl() });

    nativePool.on('connect', (client) => {
      const query = client.query.bind(client);

      client.query = ((...args: Parameters<typeof query>) => {
        if (args[0] === 'COMMIT')
          return (query('COMMIT') as Promise<pg.QueryResult>).then(
            async (result) => {
              await delay(700);

              if (outcome === 'lost-ack')
                throw Object.assign(new Error('lost acknowledgement'), {
                  code: 'ECONNRESET',
                });

              return result;
            },
          );

        return query(...args);
      }) as typeof client.query;
    });
    const runtime = app(
      createReview,
      { ...store, native: createNativePostgresStore(nativePool) },
      500,
    );

    try {
      const customer = await runtime.adopt(Customer.id, 'northwind');
      const invocation = runtime.invoke(
        ana,
        AddAccountReview.id,
        request(customer),
      );

      if (outcome === 'success')
        await expect(invocation).resolves.toMatchObject({ state: 'succeeded' });
      else
        await expect(invocation).rejects.toMatchObject({ code: 'uncertain' });

      expect(
        (
          await store.native!.loadInvocation(
            scope(),
            AddAccountReview.id,
            'review',
          )
        )?.receipt.state,
      ).toBe('succeeded');
    } finally {
      await nativePool.end();
    }
  },
);

it('does not return success when COMMIT acknowledges ROLLBACK', async () => {
  await store.install(graphId, model.definitionRevision);
  // Deliberately poison the transaction and swallow the SQL error to reach COMMIT.
  await expect(
    createNativePostgresStore(pool).transaction(scope(), async (tx) => {
      const record = {
        objectDefinitionId: AccountReview.id,
        objectId: 'one',
        values: {},
        createdAt: Date.now(),
      };

      await tx.insert(record);
      await tx.insert(record).catch(() => {});
    }),
  ).rejects.toBeInstanceOf(StorageUnavailable);
  await expectEmpty();
});

it('keeps a lost COMMIT acknowledgement uncertain even when the connection error is retryable', async () => {
  await store.install(graphId, model.definitionRevision);
  // Execute a real COMMIT, then lose its acknowledgement at the driver boundary.
  pool.on('connect', (client) => {
    const query = client.query.bind(client);

    client.query = ((...args: Parameters<typeof query>) => {
      if (args[0] === 'COMMIT')
        return (query('COMMIT') as Promise<pg.QueryResult>).then(() => {
          throw Object.assign(new Error('lost acknowledgement'), {
            code: 'ECONNRESET',
          });
        });

      return query(...args);
    }) as typeof client.query;
  });
  await expect(
    createNativePostgresStore(pool).transaction(scope(), async (tx) => {
      await tx.insert({
        objectDefinitionId: AccountReview.id,
        objectId: 'committed',
        values: {},
        createdAt: Date.now(),
      });
    }),
  ).rejects.toBeInstanceOf(NativeCommitUncertain);
  expect(
    await store.native!.load(scope(), AccountReview.id, 'committed'),
  ).toBeDefined();
});

it('maps refused connections during installation and native acquisition to unavailable', async () => {
  const server = createServer();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  if (!address || typeof address === 'string')
    throw new Error('Expected TCP address');

  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const url = new URL(testDatabaseUrl());

  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  const offline = createPostgresStore({ connectionString: url.toString() });

  try {
    await expect(
      app(createReview, offline).invoke(
        ana,
        AddAccountReview.id,
        request('unused'),
      ),
    ).rejects.toMatchObject({ name: 'ActionError', code: 'unavailable' });
    await expect(
      offline.native!.transaction(scope(), async () => {}),
    ).rejects.toBeInstanceOf(StorageUnavailable);
  } finally {
    await offline.close();
  }
});
