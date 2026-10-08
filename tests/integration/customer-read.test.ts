import { afterEach, beforeEach, expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import type { SourceConnector } from 'relate/connectors';
import { RetentionError } from '@relate/runtime/storage';
import type { ObservationStore } from '@relate/runtime/storage';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);

import { createPostgresStore } from '@relate/postgres';
import {
  access,
  Customer,
  customerGraph,
  employee,
  finance,
} from '../../examples/04-postgres-persistence/src/model.js';
import { testDatabaseUrl } from '../support/database.js';
import { startCrmSimulator } from '@relate/dev-crm-simulator';
import { crmConnector } from '../../examples/04-postgres-persistence/src/connector.js';

const model = compile(customerGraph);
const databaseUrl = testDatabaseUrl();
let crm: Awaited<ReturnType<typeof startCrmSimulator>>;
let store: ReturnType<typeof createPostgresStore>;
let runtime: ReturnType<typeof createRuntime>;
let now = Date.now();
const clock = () => now;
let graphId: string;
const connect = (
  storage: ObservationStore = store,
  connector: SourceConnector = crmConnector(crm.url),
) =>
  createRuntime({
    model,
    graphId,
    store: storage,
    clock,
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'crm-primary',
        authorization: 'shared-service',
        connector,
      },
    },
  });

beforeEach(async () => {
  graphId = randomUUID();
  now = Date.now();
  crm = await startCrmSimulator();
  store = createPostgresStore({ connectionString: databaseUrl });
  await store.migrate();
  runtime = connect();
}, 30_000);

afterEach(async () => {
  await store?.close();
  await crm?.stop();
});

it('refreshes, retains, restarts, and serves only currently authorized fallback with honest evidence', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');

  expect(await runtime.adopt(Customer.id, 'crm_456')).toBe(key);
  const initial = await runtime.read(employee, Customer.id, key, {
    select: ['id', 'name', 'revenue'],
  });

  expect(initial).toMatchObject({
    status: 'ok',
    data: { id: key, name: 'Northwind' },
    meta: { completeness: 'partial' },
  });

  if (initial.status !== 'ok') throw new Error('Expected customer');

  expect(initial.data).not.toHaveProperty('revenue');
  expect(initial.meta.fields.revenue).toEqual({ status: 'forbidden' });
  expect(
    await runtime.read(
      { ...employee, claims: { portfolio: 'other' } },
      Customer.id,
      key,
    ),
  ).toEqual({ status: 'not-found' });

  await crm.update({ display_name: 'Northwind Studio' });
  now += 1_000;
  const refreshed = await runtime.read(finance, Customer.id, key, {
    select: ['name', 'revenue'],
    refresh: true,
  });

  expect(refreshed).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind Studio', revenue: 2_000_000 },
    meta: {
      completeness: 'complete',
      degraded: false,
      fields: {
        name: {
          status: 'available',
          freshness: 'fresh',
          retention: 'confirmed',
          retentionDurability: 'persistent',
          refresh: 'succeeded',
          sourceDefinitionId: 'crm.customers',
          orderingBasis: 'source-version',
          observedAt: new Date(now).toISOString(),
        },
      },
    },
  });

  await store.close();
  store = createPostgresStore({ connectionString: databaseUrl });
  runtime = connect();
  crm.setRecordsUnavailable(true);
  now += 2_000;
  const restarted = await execFile(process.execPath, [
    fileURLToPath(new URL('../support/restarted-reader.mjs', import.meta.url)),
    JSON.stringify({
      databaseUrl: databaseUrl,
      crmUrl: crm.url,
      model,
      graphId,
      now,
      principal: employee,
      type: Customer.id,
      key,
    }),
  ]);

  expect(JSON.parse(restarted.stdout)).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind Studio' },
    meta: { fields: { name: { freshness: 'stale', retention: 'confirmed' } } },
  });
  const fallback = await runtime.read(employee, Customer.id, key, {
    select: ['name'],
    maxAgeMs: 1_000,
  });

  expect(fallback).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind Studio' },
    meta: {
      completeness: 'complete',
      degraded: true,
      fields: {
        name: {
          freshness: 'stale',
          retention: 'confirmed',
          refresh: 'unavailable',
          observedAt: new Date(now - 2_000).toISOString(),
        },
      },
    },
  });
  expect(
    await runtime.read(employee, Customer.id, key, {
      select: ['name'],
      maxAgeMs: 1_000,
      stale: 'omit',
    }),
  ).toMatchObject({
    status: 'ok',
    data: {},
    meta: { completeness: 'partial' },
  });
  await expect(
    runtime.read(employee, Customer.id, key, {
      select: ['name'],
      maxAgeMs: 1_000,
      stale: 'omit',
      requireComplete: true,
    }),
  ).rejects.toMatchObject({ code: 'incomplete' });
  expect(
    await runtime.read({ ...employee, roles: [] }, Customer.id, key),
  ).toEqual({ status: 'not-found' });
  now += 30_001;
  expect(await runtime.read(employee, Customer.id, key)).toEqual({
    status: 'not-found',
  });
});

it('keeps raw inputs private and commits value history only when mapped values change', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  const db = new pg.Client({ connectionString: databaseUrl });

  await db.connect();

  try {
    const changes = async () =>
      (
        await db.query('SELECT * FROM relate.value_changes WHERE graph_id=$1', [
          graphId,
        ])
      ).rows;

    expect(await changes()).toHaveLength(1);
    const initialValues = (await changes())[0].values;

    expect(Object.keys(initialValues).sort()).toEqual(
      [
        Customer.properties.name.id,
        Customer.properties.portfolio.id,
        Customer.properties.revenue.id,
      ].sort(),
    );
    expect(initialValues[Customer.properties.name.id]).toBe('Northwind');
    now += 100;
    await runtime.read(employee, Customer.id, key, { refresh: true });
    expect(await changes()).toHaveLength(1);
    await crm.update({ private_unmapped: 'new private source data' });
    now += 100;
    const result = await runtime.read(finance, Customer.id, key, {
      refresh: true,
    });

    expect(JSON.stringify(result)).not.toContain('private');
    expect(await changes()).toHaveLength(1);
    const retained = (
      await db.query(
        'SELECT observation FROM relate.objects WHERE graph_id=$1',
        [graphId],
      )
    ).rows[0].observation;

    expect(retained.values).toEqual(initialValues);
    expect(retained.raw.private_unmapped).toBe('new private source data');
    expect(retained.observedAt).toBe(now);
    await crm.update({ display_name: 'Changed' });
    now += 100;
    await runtime.read(employee, Customer.id, key, { refresh: true });
    expect(await changes()).toHaveLength(2);
    expect(
      (await changes())
        .map((row) => row.values[Customer.properties.name.id])
        .sort(),
    ).toEqual(['Changed', 'Northwind']);
  } finally {
    await db.end();
  }
});

it('returns fresh authorized transient values when retention fails without changing durable fallback', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');

  await crm.update({ display_name: 'Transient name' });
  now += 100;
  const failing = connect({
    ...store,
    accept: async () => {
      throw new RetentionError('failed');
    },
  });
  const result = await failing.read(employee, Customer.id, key, {
    select: ['name'],
    refresh: true,
  });

  expect(result).toMatchObject({
    status: 'ok',
    data: { name: 'Transient name' },
    meta: {
      completeness: 'complete',
      degraded: true,
      fields: {
        name: {
          freshness: 'fresh',
          retention: 'failed',
          ordering: 'confirmed',
        },
      },
      warnings: ['observation_not_retained'],
    },
  });
  crm.setRecordsUnavailable(true);
  expect(
    await runtime.read(employee, Customer.id, key, {
      select: ['name'],
      refresh: true,
    }),
  ).toMatchObject({ status: 'ok', data: { name: 'Northwind' } });
});

it('distinguishes an unconfirmed commit, successful readback, and unavailable ordering evidence', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');

  await crm.update({ display_name: 'Committed despite lost acknowledgement' });
  now += 100;
  const lostAck = connect({
    ...store,
    accept: async (...args) => {
      await store.accept(...args);
      throw new RetentionError('unconfirmed');
    },
  });

  expect(
    await lostAck.read(employee, Customer.id, key, {
      select: ['name'],
      refresh: true,
    }),
  ).toMatchObject({
    status: 'ok',
    meta: {
      degraded: false,
      fields: { name: { retention: 'confirmed' } },
      warnings: [],
    },
  });
  await crm.update({ display_name: 'Uncertain' });
  let loads = 0;
  const uncertain = connect({
    ...store,
    accept: async () => {
      throw new RetentionError('unconfirmed');
    },
    load: async (...args) => {
      if (++loads > 1) throw new Error('Database disconnected');

      return store.load(...args);
    },
  });

  expect(
    await uncertain.read(employee, Customer.id, key, {
      select: ['name'],
      refresh: true,
    }),
  ).toMatchObject({
    status: 'ok',
    data: { name: 'Uncertain' },
    meta: {
      degraded: true,
      fields: { name: { retention: 'unconfirmed', ordering: 'unconfirmed' } },
      warnings: ['retention_unconfirmed', 'ordering_unconfirmed'],
    },
  });
  // A new unretained observation cannot renew expired permission evidence.
  now += 30_001;
  const failed = connect({
    ...store,
    accept: async () => {
      throw new RetentionError('failed');
    },
  });

  expect(
    await failed.read(employee, Customer.id, key, { refresh: true }),
  ).toEqual({ status: 'not-found' });
});

it('does not leak hidden fields or adopt records from a read and scopes fallback to graph and connection', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  let calls = 0;
  const counted = connect(store, {
    identify: async () => 'example-account',
    fetch: async (...args) => {
      calls++;

      return crmConnector(crm.url).fetch(...args);
    },
  });

  expect(
    await counted.read({ ...employee, roles: [] }, Customer.id, key, {
      refresh: true,
    }),
  ).toEqual({ status: 'not-found' });
  expect(
    await counted.read(employee, Customer.id, 'crm_456', {
      refresh: true,
    }),
  ).toEqual({ status: 'not-found' });
  const hidden = await counted.read(employee, Customer.id, key, {
    select: ['revenue', 'unknown'],
    refresh: false,
  });

  expect(hidden).toMatchObject({
    data: {},
    meta: {
      fields: {
        revenue: { status: 'forbidden' },
        unknown: { status: 'unavailable' },
      },
    },
  });
  expect(calls).toBe(0);
  const other = createRuntime({
    model,
    graphId,
    store,
    clock,
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'another-account',
        authorization: 'shared-service',
        connector: crmConnector(crm.url),
      },
    },
  });

  expect(await other.read(employee, Customer.id, key)).toEqual({
    status: 'not-found',
  });
  const otherGraph = createRuntime({
    model,
    graphId: randomUUID(),
    store,
    clock,
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'crm-primary',
        authorization: 'shared-service',
        connector: crmConnector(crm.url),
      },
    },
  });

  expect(await otherGraph.read(employee, Customer.id, key)).toEqual({
    status: 'not-found',
  });
});

it('withholds confirmed deletion and newly denied access even if retention fails', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  const failed = connect({
    ...store,
    accept: async () => {
      throw new RetentionError('failed');
    },
  });

  await crm.update({ portfolio: 'other' });
  expect(
    await failed.read(employee, Customer.id, key, { refresh: true }),
  ).toEqual({ status: 'not-found' });
  await crm.update({}, true);
  expect(
    await failed.read(employee, Customer.id, key, { refresh: true }),
  ).toEqual({ status: 'not-found' });
  expect(
    await runtime.read(employee, Customer.id, key, { refresh: true }),
  ).toEqual({ status: 'not-found' });
  crm.setRecordsUnavailable(true);
  expect(await runtime.read(employee, Customer.id, key)).toEqual({
    status: 'not-found',
  });
});

it('refuses a provider-denied refresh without fallback and leaves cached reads to the freshness window', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');

  crm.setAccess('denied');
  expect(
    await runtime.read(employee, Customer.id, key, {
      select: ['name'],
      refresh: true,
    }),
  ).toEqual({ status: 'not-found' });
  // Record denial is not persisted: fresh cached reads only verify account identity.
  expect(
    await runtime.read(employee, Customer.id, key, { select: ['name'] }),
  ).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind' },
    meta: { fields: { name: { refresh: 'not-needed' } } },
  });
  now += 60_001;
  expect(
    await runtime.read(employee, Customer.id, key, { select: ['name'] }),
  ).toEqual({ status: 'not-found' });
  crm.setAccess('granted');
  expect(
    await runtime.read(employee, Customer.id, key, { select: ['name'] }),
  ).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind' },
    meta: { fields: { name: { refresh: 'succeeded' } } },
  });
});

it('bounds source waits and rejects malformed observations without overwriting retained data', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  const hanging = connect(store, {
    identify: async () => 'example-account',
    fetch: () => new Promise(() => {}),
  });
  const start = Date.now();

  expect(
    await hanging.read(employee, Customer.id, key, {
      select: ['name'],
      refresh: true,
      timeoutMs: 20,
    }),
  ).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind' },
    meta: { degraded: true, fields: { name: { refresh: 'unavailable' } } },
  });
  expect(Date.now() - start).toBeLessThan(2_000);
  await crm.update({ display_name: null });
  expect(
    await runtime.read(employee, Customer.id, key, {
      select: ['name'],
      refresh: true,
    }),
  ).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind' },
    meta: { fields: { name: { refresh: 'invalid' } } },
  });
});

it('keeps the later accepted observation when two real database clients race', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  let release!: (value: Awaited<ReturnType<SourceConnector['fetch']>>) => void;
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const slow = connect(store, {
    identify: async () => 'example-account',
    fetch: async () => {
      started();

      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const pending = slow.read(employee, Customer.id, key, {
    select: ['name'],
    refresh: true,
  });

  await fetching;
  await crm.update({ display_name: 'Newer accepted name' });
  now += 100;
  expect(
    await runtime.read(employee, Customer.id, key, { refresh: true }),
  ).toMatchObject({ data: { name: 'Newer accepted name' } });
  release({
    providerAccountId: 'example-account',
    state: 'present',
    record: {
      id: 'crm_456',
      display_name: 'Northwind',
      portfolio: 'portfolio_north',
      revenue: 2_000_000,
      private_unmapped: 'never return this',
    },
    version: { domain: 'crm-v1', value: '1' },
  });
  expect(await pending).toMatchObject({
    data: { name: 'Newer accepted name' },
    meta: {
      fields: {
        name: {
          refresh: 'superseded',
          observedAt: new Date(now).toISOString(),
        },
      },
    },
  });
});

it('rolls back raw retention, projection and history together on a database write failure', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  const db = new pg.Client({ connectionString: databaseUrl });

  await db.connect();

  try {
    await db.query(
      `CREATE FUNCTION relate.reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`,
    );
    await db.query(
      'CREATE TRIGGER reject_history BEFORE INSERT ON relate.value_changes FOR EACH ROW EXECUTE FUNCTION relate.reject_history()',
    );
    await crm.update({ display_name: 'Not committed' });
    expect(
      await runtime.read(employee, Customer.id, key, {
        select: ['name'],
        refresh: true,
      }),
    ).toMatchObject({
      data: { name: 'Not committed' },
      meta: { fields: { name: { retention: 'failed' } } },
    });
    const stored = (
      await db.query(
        'SELECT observation FROM relate.objects WHERE graph_id=$1',
        [graphId],
      )
    ).rows[0].observation;

    expect(stored.raw.display_name).toBe('Northwind');
    expect(stored.values[Customer.properties.name.id]).toBe('Northwind');
    expect(
      (
        await db.query('SELECT * FROM relate.value_changes WHERE graph_id=$1', [
          graphId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await db.query(
      'DROP TRIGGER IF EXISTS reject_history ON relate.value_changes',
    );
    await db.query('DROP FUNCTION IF EXISTS relate.reject_history()');
    await db.end();
  }
});

it('distinguishes absent optional values, legitimate null, and unavailable selections', async () => {
  const { defineSource, defineObject, from, objectId, source } =
    await import('relate');
  const { z } = await import('zod');
  const resource = defineSource({
    id: 'optional.source',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      note: z.string().nullable().optional(),
    }),
  });
  const object = defineObject({
    id: 'optional.object',
    label: 'Optional',
    membership: source(resource),
    properties: {
      customerId: objectId({
        id: 'optional.key',
        access: access.groups.ordinary,
      }),
      note: from(resource.fields.note, {
        id: 'optional.note',
        access: access.groups.ordinary,
      }),
    },
  });
  const optionalModel = compile({
    id: 'optional.graph',
    objects: { object },
    access,
    policies: {
      object: {
        read: { gate: access.role('employee') },
      },
    },
  });
  let record: { id: string; note?: string | null } = {
    id: 'source-1',
    note: null,
  };
  const optional = createRuntime({
    model: optionalModel,
    graphId: randomUUID(),
    store,
    clock,
    sources: {
      [resource.id]: {
        providerAccountId: 'example-account',
        connectionId: 'optional-account',
        authorization: 'shared-service',
        connector: {
          identify: async () => 'example-account',
          fetch: async () => ({
            providerAccountId: 'example-account',
            state: 'present',
            record,
          }),
        },
      },
    },
  });
  const key = await optional.adopt(object.id, record.id);

  expect(key).not.toBe(record.id);
  expect(await optional.adopt(object.id, record.id)).toBe(key);
  expect(
    await optional.read(employee, object.id, key, {
      select: ['customerId'],
    }),
  ).toMatchObject({ data: { customerId: key } });

  expect(
    await optional.read(employee, object.id, key, {
      select: ['note'],
    }),
  ).toMatchObject({
    data: { note: null },
    meta: {
      completeness: 'complete',
      fields: { note: { status: 'available' } },
    },
  });
  record = { id: 'source-1' };
  expect(
    await optional.read(employee, object.id, key, {
      select: ['note'],
      refresh: true,
    }),
  ).toMatchObject({
    data: {},
    meta: { completeness: 'complete', fields: { note: { status: 'absent' } } },
  });
  expect(
    await optional.read(employee, object.id, key, {
      select: ['missing'],
    }),
  ).toMatchObject({
    data: {},
    meta: {
      completeness: 'partial',
      fields: { missing: { status: 'unavailable' } },
    },
  });
});

it('denies absent policies and rejects compiled model drift against an installed graph', async () => {
  const key = await runtime.adopt(Customer.id, 'crm_456');
  const deniedModel = compile({
    ...customerGraph,
    policies: { Customer: { read: 'deny' } },
  });
  const denied = createRuntime({
    model: deniedModel,
    graphId: randomUUID(),
    store,
    clock,
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'crm-primary',
        authorization: 'shared-service',
        connector: crmConnector(crm.url),
      },
    },
  });

  expect(await denied.read(employee, Customer.id, key)).toEqual({
    status: 'not-found',
  });
  const changed = compile({ ...customerGraph, id: 'another.graph' });
  const incompatible = createRuntime({
    model: changed,
    graphId,
    store,
    clock,
    sources: {
      'crm.customers': {
        providerAccountId: 'example-account',
        connectionId: 'crm-primary',
        authorization: 'shared-service',
        connector: crmConnector(crm.url),
      },
    },
  });

  await expect(incompatible.read(employee, Customer.id, key)).rejects.toThrow(
    'explicit migration required',
  );
  expect(() =>
    createRuntime({
      model: { ...model, definitionRevision: 'wrong' },
      graphId,
      store,
      sources: {},
    }),
  ).toThrow('Invalid compiled model');
});

it.each(['source-failure', 'conflicting-version'] as const)(
  'rechecks the retained winner when %s races with an authorization change',
  async (failure) => {
    const key = await runtime.adopt(Customer.id, 'crm_456');
    let complete!: () => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = connect(store, {
      identify: async () => 'example-account',
      fetch: async () => {
        started();
        await new Promise<void>((resolve) => {
          complete = resolve;
        });

        if (failure === 'source-failure') throw new Error('CRM unavailable');

        return {
          providerAccountId: 'example-account',
          state: 'present',
          record: {
            id: 'crm_456',
            display_name: 'Northwind',
            portfolio: 'portfolio_north',
            revenue: 2_000_000,
            private_unmapped: 'never return this',
          },
          version: { domain: 'crm-v1', value: '2' },
        };
      },
    });
    const pending = slow.read(employee, Customer.id, key, {
      refresh: true,
    });

    await fetching;
    await crm.update({ portfolio: 'other' });
    expect(
      await runtime.read(employee, Customer.id, key, {
        refresh: true,
      }),
    ).toEqual({ status: 'not-found' });
    complete();
    expect(await pending).toEqual({ status: 'not-found' });
  },
);

it('verifies the HTTP provider account before cached reads and refreshes', async () => {
  const id = await runtime.adopt(Customer.id, 'crm_456');

  crm.setAccount('another-provider-account');
  await crm.update({ display_name: 'Unrelated account customer' });
  expect(await runtime.read(employee, Customer.id, id)).toEqual({
    status: 'not-found',
  });
  expect(
    await connect().read(employee, Customer.id, id, { refresh: true }),
  ).toEqual({ status: 'not-found' });
  await expect(runtime.adopt(Customer.id, 'crm_456')).rejects.toThrow();
  crm.setAccount('example-account');
  expect(await runtime.read(employee, Customer.id, id)).toMatchObject({
    data: { name: 'Northwind' },
  });
});

it('does not disclose retained values when the HTTP identity endpoint is unavailable', async () => {
  const id = await runtime.adopt(Customer.id, 'crm_456');

  await crm.stop();
  await expect(runtime.read(employee, Customer.id, id)).rejects.toMatchObject({
    code: 'unavailable',
  });
});
