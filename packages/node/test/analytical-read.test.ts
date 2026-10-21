import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { bind, defineApp } from 'relate';
import type { ObjectId } from 'relate';
import type { AnalyticalConnector } from 'relate/connectors';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import { testCreation } from '../../../tests/support/activity.js';

const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();

  cleanup.length = 0;
});

async function app() {
  const { graph, Customer, Events } = createAnalyticalGraph();
  const directory = mkdtempSync(join(tmpdir(), 'relate-public-analytics-'));

  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.sqlite');
  const db = new DatabaseSync(path);

  db.exec(
    "CREATE TABLE events(customerId TEXT NOT NULL, amount INTEGER NOT NULL, secret TEXT NOT NULL); INSERT INTO events VALUES ('acme', 9007199254740993, 'secret-one'), ('acme', 2, 'secret-two')",
  );
  db.close();
  const connection = sqlite({ connectionId: 'events', path });
  const hooks: { execute?: AnalyticalConnector['execute'] } = {};
  const resource = connection.table('events');
  const selected = {
    ...resource,
    connection: {
      ...connection,
      analytics: {
        ...connection.analytics,
        execute: (...args: Parameters<AnalyticalConnector['execute']>) =>
          hooks.execute
            ? hooks.execute(...args)
            : connection.analytics.execute(...args),
      },
    },
  };
  const model = compile(graph);
  const store = createMemoryStore();
  const scope = {
    graphId: graph.id,
    definitionRevision: model.definitionRevision,
  };

  await store.install(scope.graphId, scope.definitionRevision);
  await store.native!.transaction(scope, async (transaction) => {
    await transaction.insert(
      {
        objectDefinitionId: Customer.id,
        objectId: 'one',
        createdAt: Date.now(),
        values: { 'customer.external': 'acme', 'customer.label': 'Acme' },
      },
      testCreation(),
    );
  });
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        onDispose(() => connection.close());

        return { store, bindings: [bind(Events, selected)] };
      },
    }),
  );

  cleanup.push(() => runtime.close());
  const principal = {
    id: 'ana',
    roles: ['reader', 'analyst', 'private'],
    claims: {},
  };

  return {
    runtime,
    principal,
    hooks,
    connection,
    store,
    scope,
    id: 'one' as ObjectId<'customer'>,
  };
}

it('reads caller and declared calculations through the typed Node host with exact int64 and private dependencies', async () => {
  const { runtime, principal, id } = await app();
  const result = await runtime.as(principal).objects.Customer.get(id, {
    select: ['label', 'count'],
    evidence: 'full',
    compute: { total: { sql: 'SELECT SUM(amount) FROM self.events' } },
  });

  expect(result.status).toBe('ok');

  if (result.status !== 'ok') return;

  expect(result.data).toEqual({
    label: 'Acme',
    count: '2',
    total: '9007199254740995',
  });
  expect(result.meta.computed).toEqual({
    total: { type: 'int64', nullable: true },
    count: { type: 'int64', nullable: false },
  });
  expect(result.meta.fields.total).toMatchObject({
    source: 'computed',
    freshness: 'unverified',
    coverage: 'complete',
    dependencies: { externalId: { source: 'native', status: 'available' } },
  });
  expect(result.meta.completeness).toBe('complete');
  expect(result.meta.degraded).toBe(false);
  expect(JSON.stringify(result.meta)).not.toMatch(
    /SELECT|acme|events.sqlite|secret-one/,
  );
  expect(result.meta.fields).not.toHaveProperty('externalId');
});

it('preserves computed evidence and result types in compact mode and default selection', async () => {
  const { runtime, principal, id } = await app();
  const result = await runtime.as(principal).objects.Customer.get(id);

  expect(result).toMatchObject({
    status: 'ok',
    data: { count: '2' },
    meta: {
      evidence: 'compact',
      computed: { count: { type: 'int64', nullable: false } },
      fields: { count: { source: 'computed', freshness: 'unverified' } },
    },
  });
});

it('does no analytical work for missing objects and rejects invalid SQL before object lookup', async () => {
  const { runtime, principal } = await app();
  const operations = runtime.operations(principal);

  expect(
    await operations.get('customer', 'missing', {
      compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
    }),
  ).toEqual({ status: 'not-found' });
  await expect(
    operations.get('customer', 'missing', {
      compute: { n: { sql: 'SELECT COUNT(nope) FROM self.events' } },
    }),
  ).rejects.toMatchObject({
    code: 'invalid-request',
    issues: [
      { path: ['compute', 'n', 'sql'], location: { line: 1, column: 14 } },
    ],
  });
});

it('withholds a declared calculation with a hidden association without exposing its SQL', async () => {
  const { runtime, id } = await app();
  const result = await runtime
    .operations({ id: 'fin', roles: ['reader', 'private'], claims: {} })
    .get('customer', id, { select: ['count'] });

  expect(result).toMatchObject({
    status: 'ok',
    data: {},
    meta: {
      completeness: 'partial',
      degraded: false,
      fields: { count: { status: 'forbidden' } },
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/events|SELECT/);
});

it('reports missing correlation and honors requireComplete', async () => {
  const { runtime, id } = await app();
  const operations = runtime.operations({
    id: 'fin',
    roles: ['reader', 'analyst'],
    claims: {},
  });
  const compute = { n: { sql: 'SELECT COUNT(*) FROM self.events' } };

  expect(
    await operations.get('customer', id, { select: [], compute }),
  ).toMatchObject({
    status: 'ok',
    data: {},
    meta: {
      fields: {
        n: { status: 'unavailable', reason: 'correlation-unavailable' },
      },
    },
  });
  await expect(
    operations.get('customer', id, {
      select: [],
      compute,
      requireComplete: true,
    }),
  ).rejects.toMatchObject({
    code: 'incomplete',
    issues: [{ path: ['n'], message: 'correlation-unavailable' }],
  });
});

it('withdraws a result when the ordinary dependency changes during the statement', async () => {
  const { runtime, principal, store, id } = await app();
  const native = store.native!;
  const original = native.load.bind(native);
  let reads = 0;

  native.load = async (...args) => {
    const record = await original(...args);

    reads++;

    return record && reads > 1
      ? {
          ...record,
          values: { ...record.values, 'customer.external': 'different' },
        }
      : record;
  };
  const result = await runtime
    .operations(principal)
    .get('customer', id, { select: ['count'] });

  expect(result).toMatchObject({
    status: 'ok',
    data: {},
    meta: {
      fields: {
        count: { status: 'unavailable', reason: 'correlation-unavailable' },
      },
    },
  });
});

it('returns exact caller values over trusted dispatch', async () => {
  const { runtime, principal, id } = await app();
  const result = await runtime.host.dispatch(
    principal,
    { operationId: '019a12cc-7b00-7000-8000-000000000001' },
    'get',
    [
      'customer',
      id,
      {
        select: [],
        compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
      },
    ],
  );

  expect(result).toMatchObject({
    data: { n: '2' },
    meta: { computed: { n: { type: 'int64', nullable: false } } },
  });
});

it('withholds an object removed before final revalidation', async () => {
  const { runtime, principal, store, id } = await app();
  const native = store.native!;
  const original = native.load.bind(native);
  let reads = 0;

  native.load = async (...args) =>
    ++reads > 1 ? undefined : original(...args);
  expect(
    await runtime
      .operations(principal)
      .get('customer', id, { select: ['count'] }),
  ).toEqual({ status: 'not-found' });
});

it.each(['timeout', 'retirement'] as const)(
  'waits for connector cleanup and fails the entire read on %s',
  async (cause) => {
    const { runtime, principal, hooks, id } = await app();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cancelled!: () => void;
    const aborted = new Promise<void>((resolve) => {
      cancelled = resolve;
    });

    hooks.execute = async (_plan, { signal }) => {
      entered();
      signal.addEventListener('abort', cancelled, { once: true });
      await aborted;
      await cleanup;
      throw signal.reason;
    };
    let settled = false;
    const result = runtime
      .operations(principal)
      .get('customer', id, {
        select: ['count'],
        ...(cause === 'timeout' ? { timeoutMs: 20 } : {}),
      })
      .then(
        () => {
          settled = true;

          return undefined;
        },
        (error) => {
          settled = true;

          return error;
        },
      );

    await started;
    const closing = cause === 'retirement' ? runtime.close() : undefined;

    await aborted;
    expect(settled).toBe(false);
    release();
    expect(await result).toMatchObject({
      code: cause === 'retirement' ? 'runtime-retired' : 'unavailable',
    });
    await closing;
  },
);

it('keeps malformed request errors structured when default selection contains a calculation', async () => {
  const { runtime, principal, id } = await app();

  await expect(
    runtime.operations(principal).get('customer', id, null as never),
  ).rejects.toMatchObject({ code: 'invalid-request' });
});
