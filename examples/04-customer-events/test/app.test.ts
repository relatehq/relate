import { expect, it, onTestFinished } from 'vitest';
import { startApp } from '@relate/node';
import { decodeComputed } from 'relate/consumer';
import { compile } from 'relate/compiler';
import { app, declaredApp } from '../src/app.js';
import { actors, graph } from '../src/graph.js';
import { seed, seedDeclared } from '../src/seed.js';
import {
  octoberLogins,
  lastLogin,
  loginsSinceCustomer,
} from '../src/queries.js';

it('computes the documented October counts, latest login and per-customer dependency', async () => {
  const runtime = await startApp(app);

  onTestFinished(() => runtime.close());
  await seed(runtime);
  const page = await runtime.as(actors.ana).objects.Customer.query({
    select: ['name'],
    compute: {
      loginsOct: octoberLogins,
      lastLogin,
      sinceCustomer: loginsSinceCustomer,
    },
    orderBy: [{ field: 'lastLogin', direction: 'desc' }],
    evidence: 'full',
  });

  expect(page.data.map((row) => row.data)).toEqual([
    {
      name: 'Acme',
      loginsOct: '2',
      lastLogin: '2026-10-09T10:30:00.000Z',
      sinceCustomer: '2',
    },
    {
      name: 'Globex',
      loginsOct: '1',
      lastLogin: '2026-10-03T14:00:00.000Z',
      sinceCustomer: '1',
    },
    { name: 'Initech', loginsOct: '0', lastLogin: null, sinceCustomer: '0' },
  ]);
  expect(decodeComputed(page.data[0]!)).toEqual({
    loginsOct: 2n,
    lastLogin: new Date('2026-10-09T10:30:00.000Z'),
    sinceCustomer: 2n,
  });
  expect(page.data[0]!.meta.fields?.loginsOct).toMatchObject({
    status: 'available',
    source: 'computed',
    freshness: 'unverified',
  });
  expect(compile(graph).manifest.objects[0]!.calculations ?? []).toEqual([]);
});

it('filters computed aliases and pages the whole authorized order without skips or repeats', async () => {
  const runtime = await startApp(app);

  onTestFinished(() => runtime.close());
  await seed(runtime);
  const customer = runtime.as(actors.ana).objects.Customer;
  const inactive = await customer.query({
    select: ['name'],
    compute: { loginsOct: octoberLogins },
    where: { loginsOct: { eq: '0' } },
  });

  expect(inactive.data.map((row) => row.data.name)).toEqual(['Initech']);
  const names = [];

  for await (const row of customer.query({
    select: ['name'],
    compute: { lastLogin },
    orderBy: [{ field: 'lastLogin', direction: 'desc' }],
    limit: 1,
  }))
    names.push(row.data.name);

  expect(names).toEqual(['Acme', 'Globex', 'Initech']);
});

it('keeps portfolio, association and identifying-column restrictions independent', async () => {
  const runtime = await startApp(app);

  onTestFinished(() => runtime.close());
  const ids = await seed(runtime);
  const ana = runtime.as(actors.ana).objects.Customer;

  expect(
    (
      await ana.get(ids.crm_umbrella!, {
        select: ['name'],
        compute: { loginsOct: octoberLogins },
      })
    ).status,
  ).toBe('not-found');
  const forbidden = await ana.get(ids.crm_acme!, {
    select: ['name'],
    compute: {
      users: {
        sql: "SELECT COUNT(DISTINCT e.userId) FROM self.events e WHERE e.eventType = 'login'",
      },
    },
    evidence: 'full',
  });

  expect(forbidden.status).toBe('ok');

  if (forbidden.status !== 'ok') return;

  expect(forbidden.data).not.toHaveProperty('users');
  expect(forbidden.meta.fields?.users).toMatchObject({ status: 'forbidden' });
  const fin = runtime.as(actors.fin).objects.Customer;

  expect(fin.describe()).not.toHaveProperty('datasets');
  await expect(
    fin.query({ select: ['name'], compute: { loginsOct: octoberLogins } }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(ana.describe()?.datasets?.events?.columns.userId).toMatchObject({
    readable: false,
    description:
      'Identifier of the user who performed the event; null for anonymous events.',
  });
});

it('keeps caller predicates within each customer correlation and rejects changed cursor parameters', async () => {
  const runtime = await startApp(app);

  onTestFinished(() => runtime.close());
  await seed(runtime);
  const customer = runtime.as(actors.ana).objects.Customer;
  const broad = await customer.query({
    select: ['name'],
    compute: {
      events: {
        sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login' OR 1 = 1",
      },
    },
    orderBy: [{ field: 'events', direction: 'desc' }],
  });

  expect(broad.data.map((row) => [row.data.name, row.data.events])).toEqual([
    ['Acme', '4'],
    ['Globex', '1'],
    ['Initech', '0'],
  ]);
  const request = {
    select: ['name'],
    compute: { loginsOct: octoberLogins },
    orderBy: [{ field: 'loginsOct', direction: 'desc' }],
    limit: 1,
  } as const;
  const first = await customer.query(request);

  expect(first.meta.continuationCursor).toBeDefined();
  await expect(
    customer.query({
      ...request,
      cursor: first.meta.continuationCursor!,
      compute: {
        loginsOct: {
          ...octoberLogins,
          parameters: {
            ...octoberLogins.parameters,
            since: '2026-10-05T00:00:00.000Z',
          },
        },
      },
    }),
  ).rejects.toMatchObject({
    code: 'invalid-request',
    issues: [{ problem: 'invalid-cursor' }],
  });
});

it('uses the same values and logical metadata for declared and caller calculations', async () => {
  const runtime = await startApp(declaredApp);

  onTestFinished(() => runtime.close());
  await seedDeclared(runtime);
  const customer = runtime.as(actors.ana).objects.Customer;
  const page = await customer.query({
    select: ['name', 'loginCount'],
    compute: {
      caller: {
        sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login'",
      },
    },
    orderBy: [{ field: 'loginCount', direction: 'desc' }],
    evidence: 'full',
  });

  expect(
    page.data.map((row) => [
      row.data.name,
      row.data.loginCount,
      row.data.caller,
    ]),
  ).toEqual([
    ['Acme', '3', '3'],
    ['Globex', '1', '1'],
    ['Initech', '0', '0'],
  ]);

  for (const row of page.data) {
    expect(row.meta.computed?.loginCount).toEqual(row.meta.computed?.caller);

    for (const field of ['loginCount', 'caller'] as const)
      expect(row.meta.fields?.[field]).toMatchObject({
        status: 'available',
        source: 'computed',
        freshness: 'unverified',
      });
  }

  const filtered = await customer.query({
    select: ['name'],
    where: { loginCount: { gte: '1' } },
    orderBy: [{ field: 'loginCount', direction: 'desc' }],
  });

  expect(filtered.data.map((row) => row.data)).toEqual([
    { name: 'Acme' },
    { name: 'Globex' },
  ]);
  expect(
    filtered.data.every(
      (row) => !Object.hasOwn(row.meta.computed ?? {}, 'loginCount'),
    ),
  ).toBe(true);
});
