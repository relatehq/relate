import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { bind, defineApp } from 'relate';
import type { ObjectId } from 'relate';
import type {
  AnalyticalConnector,
  AuthorizedDatasetQuery,
} from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
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

async function app(options: { connectionId?: string } = {}) {
  const { graph, Customer, Events } = createAnalyticalGraph();
  const directory = mkdtempSync(join(tmpdir(), 'relate-public-analytics-'));

  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.sqlite');
  const db = new DatabaseSync(path);

  db.exec(
    "CREATE TABLE events(customerId TEXT NOT NULL, amount INTEGER NOT NULL, secret TEXT NOT NULL); INSERT INTO events VALUES ('acme', 9007199254740993, 'secret-one'), ('acme', 2, 'secret-two')",
  );
  db.close();
  const connection = sqlite({
    connectionId: options.connectionId ?? 'events',
    path,
  });
  const hooks: Partial<
    Pick<AnalyticalConnector, 'execute' | 'plan' | 'parameterBudget'>
  > = {};
  const resource = connection.table('events');
  const selected = {
    ...resource,
    connection: {
      ...connection,
      analytics: {
        ...connection.analytics,
        plan: (query: AuthorizedDatasetQuery) =>
          hooks.plan ? hooks.plan(query) : connection.analytics.plan(query),
        parameterBudget: (query: Omit<AuthorizedDatasetQuery, 'slots'>) =>
          hooks.parameterBudget
            ? hooks.parameterBudget(query)
            : connection.analytics.parameterBudget(query),
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

        return {
          store,
          cursorKey: new Uint8Array(32).fill(9),
          bindings: [bind(Events, selected)],
        };
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

async function addQueryMembers(fixture: Awaited<ReturnType<typeof app>>) {
  await fixture.store.native!.transaction(
    fixture.scope,
    async (transaction) => {
      for (const [id, key] of [
        ['two', 'acme'],
        ['zero', 'empty'],
      ])
        await transaction.insert(
          {
            objectDefinitionId: 'customer',
            objectId: id!,
            createdAt: Date.now(),
            values: { 'customer.external': key!, 'customer.label': 'Acme' },
          },
          testCreation(),
        );
    },
  );
}

it('computes a membership page in one statement with duplicate correlation keys and empty input', async () => {
  const fixture = await app();

  await addQueryMembers(fixture);
  const queries: AuthorizedDatasetQuery[] = [];

  fixture.hooks.plan = (query) => {
    queries.push(query);

    return fixture.connection.analytics.plan(query);
  };
  const page = await fixture.runtime
    .as(fixture.principal)
    .objects.Customer.query({
      select: ['label', 'count'],
      compute: { sum: { sql: 'SELECT SUM(amount) FROM self.events' } },
      evidence: 'full',
      limit: 3,
    });

  expect(page.data.map((row) => row.data)).toEqual([
    { label: 'Acme', count: '2', sum: '9007199254740995' },
    { label: 'Acme', count: '2', sum: '9007199254740995' },
    { label: 'Acme', count: '0', sum: null },
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0]!.slots).toHaveLength(3);
  expect(queries[0]!.aggregates).toHaveLength(2);
  expect(page.data.every((row) => row.meta.computed.sum.type === 'int64')).toBe(
    true,
  );
  expect(JSON.stringify(page)).not.toContain('customer.external');
  expect(page.meta.exhausted).toBe(true);
});

it('supports default declared selection and typed iteration with caller aliases', async () => {
  const fixture = await app();

  await addQueryMembers(fixture);
  const counts: (string | number | boolean | null | undefined)[] = [];

  for await (const row of fixture.runtime
    .as(fixture.principal)
    .objects.Customer.query({
      limit: 1,
      compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
    })) {
    expect(row.data.count).toBe(row.data.n);
    counts.push(row.data.n);
  }

  expect(counts).toEqual(['2', '2', '0']);
});

it.each(['scalar', 'statement'] as const)(
  'withdraws %s failures across the whole returned page',
  async (failure) => {
    const fixture = await app();

    await addQueryMembers(fixture);
    fixture.hooks.parameterBudget = () => ({ fixed: 0, perSlot: 32766 });
    let statements = 0;

    fixture.hooks.execute = async (plan, options) => {
      const index = statements++;
      const result = await fixture.connection.analytics.execute(plan, options);

      if (index !== 1) return result;

      if (failure === 'statement')
        throw new DatasetExecutionError('execution-failed', {
          retryable: false,
        });

      return {
        ...result,
        rows: result.rows.map((row) => ({
          ...row,
          values: [NaN, row.values[1]!],
        })),
      };
    };
    const page = await fixture.runtime
      .operations(fixture.principal)
      .query('customer', {
        select: ['count'],
        compute: { sum: { sql: 'SELECT SUM(amount) FROM self.events' } },
        limit: 3,
      });

    expect(statements).toBe(3);

    for (const row of page.data) {
      expect(row.data).not.toHaveProperty('sum');
      expect(row.meta.fields?.sum).toMatchObject({
        status: 'unavailable',
        reason: failure === 'scalar' ? 'invalid-result' : 'execution-failed',
      });

      if (failure === 'scalar') expect(row.data).toHaveProperty('count');
      else expect(row.data).not.toHaveProperty('count');
    }
  },
);

it('rechecks ordinary filters after computation and preserves an opaque continuation for a dropped page', async () => {
  const fixture = await app();

  await addQueryMembers(fixture);
  let executed = false;

  fixture.hooks.execute = async (...args) => {
    const result = await fixture.connection.analytics.execute(...args);

    executed = true;

    return result;
  };
  const native = fixture.store.native!;
  const original = native.load.bind(native);

  native.load = async (...args) => {
    const record = await original(...args);

    return executed && record?.objectId === 'one'
      ? { ...record, values: { ...record.values, 'customer.label': 'Changed' } }
      : record;
  };
  const request = {
    select: ['count'],
    where: { label: 'Acme' },
    limit: 1,
  } as const;
  const first = await fixture.runtime
    .operations(fixture.principal)
    .query('customer', request);

  expect(first.data).toEqual([]);
  expect(first.meta.exhausted).toBe(false);

  if (first.meta.exhausted) return;

  expect(first.meta.continuationCursor).not.toContain('one');
  const next = await fixture.runtime
    .operations(fixture.principal)
    .query('customer', { ...request, cursor: first.meta.continuationCursor });

  expect(next.data.map((row) => row.id)).toEqual(['two']);
  expect(next.data[0]!.data).toEqual({ count: '2' });
});

it('binds analytical cursors to parameters, selected fields and dataset binding revisions while allowing evidence changes', async () => {
  const fixture = await app();

  await addQueryMembers(fixture);
  const request = {
    select: ['count'],
    compute: {
      n: {
        sql: 'SELECT COUNT(*) FROM self.events WHERE amount >= $threshold',
        parameters: { threshold: '1' },
      },
    },
    limit: 1,
  } as const;
  const first = await fixture.runtime
    .operations(fixture.principal)
    .query('customer', request);

  expect(first.meta.exhausted).toBe(false);

  if (first.meta.exhausted) return;

  const cursor = first.meta.continuationCursor;
  const next = await fixture.runtime
    .operations(fixture.principal)
    .query('customer', { ...request, cursor, evidence: 'full' });

  expect(next.data[0]!.id).toBe('two');

  for (const changed of [
    {
      ...request,
      compute: { n: { ...request.compute.n, parameters: { threshold: '2' } } },
    },
    { ...request, select: ['label'] },
    { ...request, requireComplete: true },
  ])
    await expect(
      fixture.runtime
        .operations(fixture.principal)
        .query('customer', { ...changed, cursor }),
    ).rejects.toMatchObject({
      code: 'invalid-request',
      issues: [{ problem: 'invalid-cursor' }],
    });

  const other = await app({ connectionId: 'other-events' });

  await expect(
    other.runtime
      .operations(other.principal)
      .query('customer', { ...request, cursor }),
  ).rejects.toMatchObject({
    code: 'invalid-request',
    issues: [{ problem: 'invalid-cursor' }],
  });
});

it('validates compute before reading an empty membership page and performs no statement for no matches', async () => {
  const fixture = await app();
  let statements = 0;

  fixture.hooks.execute = async (...args) => {
    statements++;

    return fixture.connection.analytics.execute(...args);
  };
  const operations = fixture.runtime.operations(fixture.principal);

  await expect(
    operations.query('customer', {
      where: { label: 'missing' },
      compute: { n: { sql: 'SELECT COUNT(missing) FROM self.events' } },
    }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  const page = await operations.query('customer', {
    where: { label: 'missing' },
    compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
  });

  expect(page.data).toEqual([]);
  expect(statements).toBe(0);
});

it('joins ordinary candidate reads on retirement before returning a failed query', async () => {
  const fixture = await app();

  await addQueryMembers(fixture);
  const native = fixture.store.native!;
  const original = native.load.bind(native);
  const releases: (() => void)[] = [];
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });

  native.load = async (...args) => {
    await new Promise<void>((resolve) => {
      releases.push(resolve);

      if (releases.length === 3) entered();
    });

    return original(...args);
  };
  let settled = false;
  const result = fixture.runtime
    .operations(fixture.principal)
    .query('customer', { select: ['count'], limit: 3 })
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

  await ready;
  const closing = fixture.runtime.close();

  releases[0]!();
  await Promise.resolve();
  expect(settled).toBe(false);

  for (const release of releases.slice(1)) release();

  expect(await result).toMatchObject({ code: 'runtime-retired' });
  await closing;
});
