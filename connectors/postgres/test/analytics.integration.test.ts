import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  bind,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  native,
} from 'relate';
import { z } from 'zod';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import { testCreation } from '../../../tests/support/activity.js';
import { afterEach, expect, it, vi } from 'vitest';
import { postgres } from '@relate/connector-postgres';
import type { AnalyticalExecutionTiming } from 'relate/connectors';
import { render } from '../src/plan.js';
import { createRunner } from '../src/runner.js';
import { createClientFactory } from '../src/client.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';
import { aggregate, column, options, query } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();

  cleanups.length = 0;
});

async function fixture() {
  const schema = `analytics_${randomUUID().replaceAll('-', '')}`;
  const db = new pg.Client({ connectionString: testDatabaseUrl() });

  await db.connect();
  cleanups.push(async () => {
    try {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await db.end();
    }
  });
  await db.query(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".events(customer_id TEXT NOT NULL, kind TEXT, amount BIGINT, small INTEGER, ratio DOUBLE PRECISION, enabled BOOLEAN, at TIMESTAMPTZ(3), precise_at TIMESTAMPTZ(6));
    CREATE INDEX ON "${schema}".events(customer_id);
    INSERT INTO "${schema}".events VALUES ('acme','login',9007199254740993,2,1.25,true,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000000Z'),
      ('acme','LOGIN',2,4,2.75,false,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.123456Z'),
      ('nulls',NULL,NULL,NULL,NULL,NULL,NULL,NULL), ('other','login',100,99,99,true,'2026-10-03T00:00:00Z','2026-10-03T00:00:00Z');`);
  const connection = postgres({
    connectionId: 'analytics',
    url: testDatabaseUrl(),
  });

  cleanups.push(() => connection.close());
  const columns = {
    customerId: 'customer_id',
    kind: 'kind',
    amount: 'amount',
    small: 'small',
    ratio: 'ratio',
    enabled: 'enabled',
    at: 'at',
    preciseAt: 'precise_at',
  };
  const resource = connection
    .table('events', { schema })
    .bindDataset({ columns });

  return { schema, db, connection, resource, columns };
}

it('describes exact types, precision, nullability and unsupported physical types', async () => {
  const { connection, resource, db, schema } = await fixture();

  await db.query(
    `ALTER TABLE "${schema}".events ADD COLUMN decimal NUMERIC, ADD COLUMN local TIMESTAMP, ADD COLUMN narrow REAL, ADD COLUMN default_at TIMESTAMPTZ, ADD COLUMN label VARCHAR(20)`,
  );
  const physical = await connection.analytics.describe(resource, options());

  expect(physical.columns.customerId).toEqual({
    supportedTypes: [{ type: 'string' }],
    nullable: false,
    databaseType: 'text',
  });

  for (const [name, type] of [
    ['amount', 'int64'],
    ['small', 'int32'],
    ['ratio', 'float64'],
    ['enabled', 'boolean'],
  ] as const)
    expect(physical.columns[name]!.supportedTypes).toEqual([{ type }]);

  expect(physical.columns.at!.supportedTypes).toEqual([
    { type: 'timestamp', precision: 3 },
  ]);
  expect(physical.columns.preciseAt!.supportedTypes).toEqual([
    { type: 'timestamp', precision: 6 },
  ]);
  const extra = await connection.analytics.describe(
    connection.table('events', { schema }).bindDataset({
      columns: {
        decimal: 'decimal',
        local: 'local',
        narrow: 'narrow',
        defaultAt: 'default_at',
        label: 'label',
        missing: 'absent',
      },
    }),
    options(),
  );

  for (const name of ['decimal', 'local', 'narrow'])
    expect(extra.columns[name]!.supportedTypes).toEqual([]);

  expect(extra.columns.defaultAt!.supportedTypes).toEqual([
    { type: 'timestamp', precision: 6 },
  ]);
  expect(extra.columns.label!.supportedTypes).toEqual([{ type: 'string' }]);
  expect(extra.columns).not.toHaveProperty('missing');
});

it('executes all portable aggregate families with exact integers and timestamps', async () => {
  const { connection, resource } = await fixture();
  const aggregates = [
    aggregate('count', '*', 'int64'),
    {
      ...aggregate('count', column('kind', 'string'), 'int64'),
      distinct: true,
    },
    aggregate('sum', column('amount', 'int64'), 'int64'),
    aggregate('avg', column('small', 'int32'), 'float64'),
    aggregate('min', column('small', 'int32'), 'int32'),
    aggregate('sum', column('ratio', 'float64'), 'float64'),
    aggregate('max', column('enabled', 'boolean'), 'boolean'),
    aggregate('min', column('kind', 'string'), 'string'),
    aggregate('max', column('at', 'timestamp'), 'timestamp'),
    aggregate('max', column('preciseAt', 'timestamp', 6), 'timestamp', 6),
    {
      ...aggregate('sum', column('small', 'int32'), 'int64'),
      fallback: { type: 'int64' as const, value: 7n },
      result: { type: 'int64' as const, nullable: false },
    },
  ];
  const timings: AnalyticalExecutionTiming[] = [];
  const result = await connection.analytics.execute(
    connection.analytics.plan(query(resource, aggregates)),
    { ...options(), onTiming: (timing) => timings.push(timing) },
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [
      2n,
      2n,
      9007199254740995n,
      3,
      2,
      4,
      true,
      'LOGIN',
      '2026-10-02T00:00:00.000Z',
      '2026-10-02T00:00:00.123456Z',
      6n,
    ],
    [0n, 0n, null, null, null, null, null, null, null, null, 7n],
    [1n, 0n, null, null, null, null, null, null, null, null, 7n],
  ]);
  expect(timings.map((timing) => timing.stage)).toEqual([
    'connectionStartup',
    'execution',
  ]);
  expect(result.readAt).toMatch(/^\d{4}-.*Z$/);
});

it('keeps duplicate keys in distinct slots, masks unavailable inputs and contains caller predicates inside correlation', async () => {
  const { connection, resource } = await fixture();
  const count = {
    ...aggregate('count', '*', 'int64'),
    predicate: {
      kind: 'compare' as const,
      op: '=' as const,
      left: {
        kind: 'value' as const,
        value: { type: 'int64' as const, value: 1n },
      },
      right: {
        kind: 'value' as const,
        value: { type: 'int64' as const, value: 1n },
      },
    },
  };
  const request = query(resource, [count], ['acme', 'acme', 'ACME', 'empty']);
  const result = await connection.analytics.execute(
    connection.analytics.plan({
      ...request,
      slots: request.slots.map((slot, index) => ({
        ...slot,
        valid: [index !== 1],
      })),
    }),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    [2n],
    [0n],
    [0n],
    [0n],
  ]);
});

it('fails integer aggregate overflow and prevents writes from a bound view', async () => {
  const { connection, resource, db, schema, columns } = await fixture();

  await db.query(`INSERT INTO "${schema}".events(customer_id,amount) VALUES ('overflow',9223372036854775807),('overflow',1);
    CREATE FUNCTION "${schema}".attempt_write() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${schema}".events(customer_id) VALUES ('written'); RETURN 1; END $$;
    CREATE VIEW "${schema}".writes AS SELECT 'acme'::text AS customer_id, "${schema}".attempt_write() AS amount;`);
  await expect(
    connection.analytics.execute(
      connection.analytics.plan(
        query(
          resource,
          [aggregate('sum', column('amount', 'int64'), 'int64')],
          ['overflow'],
        ),
      ),
      options(),
    ),
  ).rejects.toMatchObject({ code: 'execution-failed', retryable: false });
  const writes = connection
    .table('writes', { schema })
    .bindDataset({ columns });

  await expect(
    connection.analytics.execute(
      connection.analytics.plan(
        query(
          writes,
          [aggregate('sum', column('amount', 'int64'), 'int64')],
          ['acme'],
        ),
      ),
      options(),
    ),
  ).rejects.toMatchObject({ code: 'execution-failed' });
  expect(
    (
      await db.query(
        `SELECT count(*) FROM "${schema}".events WHERE customer_id='written'`,
      )
    ).rows[0].count,
  ).toBe('0');
});

it.each(['abort', 'timeout', 'retire'] as const)(
  'cancels native database work and closes its session before settling: %s',
  async (mode) => {
    const { connection, db, schema, resource } = await fixture();

    await db.query(
      `CREATE VIEW "${schema}".slow AS SELECT 'acme'::text AS customer_id, g AS amount FROM generate_series(1::bigint,10000000000::bigint) g`,
    );
    const slow = connection.table('slow', { schema }).bindDataset({
      columns: { customerId: 'customer_id', amount: 'amount' },
    });
    const controller = new AbortController();
    const timings: AnalyticalExecutionTiming[] = [];
    const pending = connection.analytics.execute(
      connection.analytics.plan(
        query(
          slow,
          [aggregate('sum', column('amount', 'int64'), 'int64')],
          ['acme'],
        ),
      ),
      {
        signal: controller.signal,
        timeoutMs: mode === 'timeout' ? 60 : 5000,
        onTiming: (timing) => timings.push(timing),
      },
    );
    const outcome = pending.catch((error) => error);

    if (mode !== 'timeout') {
      await vi.waitFor(async () =>
        expect(
          (
            await db.query(
              "SELECT count(*) FROM pg_stat_activity WHERE application_name='relate-analytics' AND state='active' AND query LIKE $1",
              [`%${schema}%`],
            )
          ).rows[0].count,
        ).toBe('1'),
      );

      if (mode === 'abort') controller.abort(new Error('caller cancelled'));
      else await connection.close();
    }

    expect(await outcome).toBeInstanceOf(Error);
    await vi.waitFor(async () =>
      expect(
        (
          await db.query(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name IN ('relate-analytics','relate-analytics-control') AND datname=current_database()",
          )
        ).rows[0].count,
      ).toBe('0'),
    );
    expect(timings.map((timing) => timing.stage)).toEqual([
      'connectionStartup',
      'execution',
    ]);

    if (mode !== 'retire')
      expect(
        (
          await connection.analytics.execute(
            connection.analytics.plan(
              query(resource, [aggregate('count', '*', 'int64')], ['acme']),
            ),
            options(),
          )
        ).rows[0]!.values,
      ).toEqual([2n]);
  },
);

it('reads caller and declared calculations through the public Node host on PostgreSQL', async () => {
  const { connection, db, schema } = await fixture();

  await db.query(`CREATE TABLE "${schema}".host_events(customer_id TEXT NOT NULL, amount BIGINT NOT NULL, secret TEXT NOT NULL);
    INSERT INTO "${schema}".host_events VALUES ('acme',9007199254740993,'private'),('acme',2,'private')`);
  const { graph, Customer, Events } = createAnalyticalGraph();
  const model = compile(graph);
  const store = createMemoryStore();
  const scope = {
    graphId: graph.id,
    definitionRevision: model.definitionRevision,
  };

  await store.install(scope.graphId, scope.definitionRevision);
  await store.native!.transaction(scope, (transaction) =>
    transaction.insert(
      {
        objectDefinitionId: Customer.id,
        objectId: 'one',
        createdAt: 0,
        values: { 'customer.external': 'acme', 'customer.label': 'Acme' },
      },
      testCreation(),
    ),
  );
  const runtime = await startApp(
    defineApp({
      graph,
      setup: () => ({
        store,
        bindings: [
          bind(Events, connection.table('host_events', { schema }), {
            columns: { customerId: 'customer_id' },
          }),
        ],
      }),
    }),
  );

  cleanups.push(() => runtime.close());
  const operations = runtime.operations({
    id: 'ana',
    roles: ['reader', 'analyst', 'private'],
    claims: {},
  });
  const request = {
    select: ['label', 'count'],
    compute: { total: { sql: 'SELECT SUM(amount) FROM self.events' } },
  };
  const result = await operations.get('customer', 'one', request);

  expect(result.status).toBe('ok');

  if (result.status !== 'ok') return;

  expect(result.data).toEqual({
    label: 'Acme',
    count: '2',
    total: '9007199254740995',
  });
  const page = await operations.query('customer', request);

  expect(page.data[0]!.data).toEqual(result.data);
  await runtime.host.flushActivity();
  const records = (
    await runtime.host.activity.operations.list()
  ).entries.filter((row) => row.kind === 'get' || row.kind === 'query');

  expect(records).toHaveLength(2);

  for (const row of records)
    expect(row.details.analytical!.stages.execution!.count).toBe(1);
});

it('preserves ISO year zero and rejects unsupported temporal output without rounding it', async () => {
  const { connection, db, schema, resource } = await fixture();

  await db.query(
    `INSERT INTO "${schema}".events(customer_id,precise_at) VALUES ('ancient','0001-02-29T00:00:00.123456Z BC'),('infinite','infinity'),('older','0002-01-01T00:00:00Z BC')`,
  );
  const maximum = aggregate(
    'max',
    column('preciseAt', 'timestamp', 6),
    'timestamp',
    6,
  );
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(resource, [maximum], ['ancient', 'infinite', 'older']),
    ),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([
    ['0000-02-29T00:00:00.123456Z'],
    ['infinity'],
    ['0002-01-01T00:00:00.000000ZBC'],
  ]);
  const fallback = {
    ...maximum,
    fallback: {
      type: 'timestamp' as const,
      precision: 6 as const,
      value: '0000-02-29T00:00:00.123456Z',
    },
    result: {
      type: 'timestamp' as const,
      precision: 6 as const,
      nullable: false,
    },
  };

  expect(
    (
      await connection.analytics.execute(
        connection.analytics.plan(query(resource, [fallback], ['empty'])),
        options(),
      )
    ).rows[0]!.values,
  ).toEqual(['0000-02-29T00:00:00.123456Z']);
});

it('uses catalog built-ins even when the configured search path shadows functions and operators', async () => {
  const { schema, db, columns } = await fixture();

  await db.query(`CREATE FUNCTION "${schema}".count(text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$ SELECT 999::bigint $$;
    CREATE FUNCTION "${schema}".equal_text(text,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
    CREATE OPERATOR "${schema}".= (FUNCTION = "${schema}".equal_text, LEFTARG = text, RIGHTARG = text);`);
  const url = new URL(testDatabaseUrl());

  url.searchParams.set('options', `-c search_path=${schema},pg_catalog`);
  const connection = postgres({
    connectionId: 'shadowed',
    url: url.toString(),
  });

  cleanups.push(() => connection.close());
  const resource = connection
    .table('events', { schema })
    .bindDataset({ columns });

  expect(
    (await connection.analytics.describe(resource, options())).columns
      .customerId!.nullable,
  ).toBe(false);
  const result = await connection.analytics.execute(
    connection.analytics.plan(
      query(
        resource,
        [aggregate('count', column('kind', 'string'), 'int64')],
        ['acme', 'ACME', 'empty'],
      ),
    ),
    options(),
  );

  expect(result.rows.map((row) => row.values)).toEqual([[2n], [0n], [0n]]);
});

it('uses the real server statement timeout when its cancellation control connection is unavailable', async () => {
  const { db } = await fixture();
  const settings = {
    url: testDatabaseUrl(),
    startupTimeoutMs: 1000,
    cancelTimeoutMs: 100,
  };
  const real = createClientFactory(settings);
  const runner = createRunner(settings, (purpose) =>
    purpose === 'statement'
      ? real(purpose)
      : {
          connect: async () => {
            throw new Error('control unavailable');
          },
          query: async () => {
            throw new Error('unreachable');
          },
          cancel: async () => {},
          end: async () => {},
          destroy() {},
        },
  );

  cleanups.push(() => runner.close());
  const controller = new AbortController();
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  const timings: AnalyticalExecutionTiming[] = [];
  const outcome = runner
    .run(
      async (client) => {
        const pending = client.query('SELECT pg_catalog.pg_sleep(60)');

        admitted();

        return pending;
      },
      {
        signal: controller.signal,
        timeoutMs: 100,
        onTiming: (timing) => timings.push(timing),
      },
    )
    .catch((error) => error);

  await started;
  const reason = new Error('abort without control');

  controller.abort(reason);
  expect(await outcome).toBe(reason);
  expect(
    timings.find((timing) => timing.stage === 'execution')!.durationMs,
  ).toBeGreaterThanOrEqual(75);
  await vi.waitFor(async () =>
    expect(
      (
        await db.query(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name='relate-analytics' AND datname=current_database()",
        )
      ).rows[0].count,
    ).toBe('0'),
  );
});

it.each(['int32', 'int64'] as const)(
  'correlates native %s properties and exact self operands through the Node host',
  async (format) => {
    const { schema, db, connection } = await fixture();
    const key = format === 'int64' ? '9007199254740993' : '2147483647';
    const type = format === 'int64' ? 'BIGINT' : 'INTEGER';

    await db.query(`CREATE TABLE "${schema}".integer_events(customer_id ${type} NOT NULL, amount BIGINT NOT NULL, secret TEXT NOT NULL);
    INSERT INTO "${schema}".integer_events VALUES (${key},9007199254740993,'private'),(${key},2,'private'),(${key} - 1,9999999999999999,'other')`);
    const base = createAnalyticalGraph();
    const integer = format === 'int64' ? z.int64() : z.int32();
    const Events = defineDataset({
      id: base.Events.id,
      columns: {
        ...base.Events.columns,
        customerId: { ...base.Events.columns.customerId, schema: integer },
      },
    });
    const Customer = defineObject({
      ...base.Customer,
      properties: {
        ...base.Customer.properties,
        externalId: native(integer, { id: 'customer.external' }),
        threshold: native(z.int64(), { id: 'customer.threshold' }),
      },
      datasets: {
        events: { ...base.Customer.datasets!.events, dataset: Events },
      },
    });
    const graph = defineGraph({
      ...base.graph,
      objects: { Customer },
      datasets: { Events },
    });
    const store = createMemoryStore();
    const scope = {
      graphId: graph.id,
      definitionRevision: compile(graph).definitionRevision,
    };

    await store.install(scope.graphId, scope.definitionRevision);
    await store.native!.transaction(scope, async (transaction) => {
      await transaction.insert(
        {
          objectDefinitionId: Customer.id,
          objectId: 'one',
          createdAt: Date.now(),
          values: {
            'customer.external': format === 'int64' ? key : Number(key),
            'customer.label': 'Acme',
            'customer.threshold': '9007199254740992',
          },
        },
        testCreation(),
      );
    });
    const runtime = await startApp(
      defineApp({
        graph,
        setup: () => ({
          store,
          bindings: [
            bind(Events, connection.table('integer_events', { schema }), {
              columns: { customerId: 'customer_id' },
            }),
          ],
        }),
      }),
    );

    cleanups.push(() => runtime.close());
    const operations = runtime.operations({
      id: 'reader',
      roles: ['reader', 'analyst', 'private'],
      claims: {},
    });
    const request = {
      select: ['externalId', 'count'],
      compute: {
        above: {
          sql: 'SELECT SUM(amount) FROM self.events WHERE amount > self.threshold',
        },
      },
    };
    const result = await operations.get('customer', 'one', request);

    expect(result).toMatchObject({
      status: 'ok',
      data: {
        externalId: format === 'int64' ? key : Number(key),
        count: '2',
        above: '9007199254740993',
      },
    });
    expect(
      (
        await operations.query('customer', {
          ...request,
          where: { threshold: { gt: '20' } },
        })
      ).data[0]!.data,
    ).toEqual(result.status === 'ok' ? result.data : undefined);
  },
);

it('keeps default-collation text indexes eligible for correlation equality', async () => {
  const { db, schema, resource, columns } = await fixture();
  const request = query(resource, [aggregate('count', '*', 'int64')], ['acme']);
  const generated = render(
    request,
    { schema, table: 'events', columns },
    request.slots,
  );

  await db.query('SET enable_seqscan = off');
  const explanation = await db.query(`EXPLAIN (FORMAT JSON) ${generated.sql}`, [
    ...generated.values,
  ]);

  expect(JSON.stringify(explanation.rows)).toContain('Index Cond');
});

it('accepts smallint and domains with compatible base types', async () => {
  const { db, schema, connection } = await fixture();

  await db.query(`CREATE DOMAIN "${schema}".key_text AS text;
    ALTER TABLE "${schema}".events ADD COLUMN tiny smallint, ADD COLUMN domain_key "${schema}".key_text;`);
  const resource = connection
    .table('events', { schema })
    .bindDataset({ columns: { tiny: 'tiny', domain: 'domain_key' } });
  const physical = await connection.analytics.describe(resource, options());

  expect(physical.columns.tiny!.supportedTypes).toEqual([{ type: 'int32' }]);
  expect(physical.columns.domain!.supportedTypes).toEqual([{ type: 'string' }]);
});
