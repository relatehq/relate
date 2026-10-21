import { expect, it } from 'vitest';
import { decodeComputed } from 'relate/consumer';
import { ReadError } from '@relate/protocol';
import type { ObjectRecord, PageResult } from '@relate/protocol';
import { analyticalFixture } from './analytical-fixture.js';

const compute = {
  total: { sql: 'SELECT SUM(amount) FROM self.events' },
  latest: { sql: 'SELECT MAX(occurredAt) FROM self.events' },
  callerCount: { sql: 'SELECT COUNT(*) FROM self.events' },
} as const;

it.each(['compact', 'full'] as const)(
  'preserves exact analytical values, nulls and decodable metadata through MCP in %s mode',
  async (evidence) => {
    const fixture = await analyticalFixture();
    const mcp = await fixture.connect('ana');
    const request = {
      select: ['name', 'count'],
      compute,
      orderBy: [{ field: 'total', direction: 'desc' }],
      evidence,
    } as const;
    const embedded = await fixture.runtime
      .as(fixture.principals.ana)
      .objects.Customer.query(request);
    const remote = await mcp.execute<PageResult>(
      `return await graph.objects.Customer.query(${JSON.stringify(request)});`,
    );

    expect(remote.data.map((row) => row.data)).toEqual(
      embedded.data.map((row) => row.data),
    );
    expect(remote.data.map((row) => row.data)).toEqual([
      {
        name: 'Acme',
        count: '2',
        callerCount: '2',
        total: '9007199254740995',
        latest: '2026-10-09T10:00:00.000Z',
      },
      {
        name: 'Globex',
        count: '1',
        callerCount: '1',
        total: '10',
        latest: '2026-10-03T10:00:00.000Z',
      },
      {
        name: 'Initech',
        count: '0',
        callerCount: '0',
        total: null,
        latest: null,
      },
    ]);
    expect(remote.data.map((row) => row.meta.computed)).toEqual(
      embedded.data.map((row) => row.meta.computed),
    );
    expect(decodeComputed(remote.data[0]!)).toEqual({
      count: 2n,
      callerCount: 2n,
      total: 9007199254740995n,
      latest: new Date('2026-10-09T10:00:00.000Z'),
    });
    expect(decodeComputed(remote.data[2]!)).toMatchObject({
      count: 0n,
      total: null,
      latest: null,
    });

    for (const row of remote.data) {
      expect(row.meta.computed?.count).toEqual(row.meta.computed?.callerCount);

      if (evidence === 'full') {
        for (const field of ['count', 'callerCount', 'total', 'latest']) {
          expect(row.meta.fields?.[field]).toMatchObject({
            status: 'available',
            source: 'computed',
            freshness: 'unverified',
            inputs: [
              {
                associationId: 'customer.events',
                datasetId: 'events',
                bindingRevision: expect.any(String),
                readAt: expect.any(String),
              },
            ],
          });
        }
      }
    }

    expect(fixture.counters.statements).toBe(4); // Two batches for each complete scope, regardless of alias count.
  },
);

it('filters, orders and resumes analytical scopes through fresh MCP executions and async iteration', async () => {
  const fixture = await analyticalFixture();
  const mcp = await fixture.connect('ana');
  const request = {
    select: ['name'],
    compute,
    orderBy: [{ field: 'latest', direction: 'desc' }],
    limit: 1,
  } as const;
  const records: ObjectRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await mcp.execute<PageResult>(
      `return await graph.objects.Customer.query(${JSON.stringify({ ...request, ...(cursor ? { cursor } : {}) })});`,
    );

    records.push(...page.data);
    cursor = page.meta.continuationCursor;
  } while (cursor);

  expect(records.map((row) => row.data.name)).toEqual([
    'Acme',
    'Globex',
    'Initech',
  ]);
  expect(new Set(records.map((row) => row.id)).size).toBe(3);
  const names = await mcp.execute<string[]>(
    `const names = []; for await (const row of graph.objects.Customer.query(${JSON.stringify(request)})) names.push(row.data.name); return names;`,
  );

  expect(names).toEqual(['Acme', 'Globex', 'Initech']);
  const filtered = await mcp.execute<PageResult>(
    `return await graph.objects.Customer.query({ select: ['name'], where: { count: { eq: '0' } }, orderBy: [{ field: 'count', direction: 'asc' }] });`,
  );

  expect(filtered.data.map((row) => row.data)).toEqual([{ name: 'Initech' }]);
  expect(filtered.data[0]!.meta.computed).not.toHaveProperty('count');
});

it('withholds forbidden declared and caller values and never computes an unauthorized object', async () => {
  const fixture = await analyticalFixture();
  const ana = await fixture.connect('ana');
  const query = `graph.objects.Customer.get('a', { select: ['name', 'privateCount'], compute: { privateCaller: { sql: 'SELECT COUNT(DISTINCT secret) FROM self.events' } }, evidence: 'full' })`;
  const denied = await ana.execute<ObjectRecord>(`return await ${query};`);

  expect(denied.data).toEqual({ name: 'Acme' });

  for (const field of ['privateCount', 'privateCaller']) {
    expect(denied.meta.fields?.[field]).toMatchObject({ status: 'forbidden' });
  }

  expect(decodeComputed(denied)).toEqual({});
  expect(fixture.counters.statements).toBe(0);
  expect(
    await ana.execute(
      `return await graph.objects.Customer.get('d', { select: ['count'], compute: ${JSON.stringify(compute)} });`,
    ),
  ).toMatchObject({ status: 'not-found' });
  expect(fixture.counters.statements).toBe(0);
  const support = await fixture.connect('support');
  const allowed = await support.execute<ObjectRecord>(`return await ${query};`);

  expect(allowed.data).toEqual({
    name: 'Acme',
    privateCount: '2',
    privateCaller: '2',
  });
  const fin = await fixture.connect('fin');
  const hidden = await fin.execute<ObjectRecord>(
    `return await graph.objects.Customer.get('a', { select: ['name', 'count'], evidence: 'full' });`,
  );

  expect(hidden.data).toEqual({ name: 'Acme' });
  expect(hidden.meta.fields?.count).toMatchObject({ status: 'forbidden' });
});

it('preserves embedded validation issues through MCP, including hidden associations and changed cursor parameters', async () => {
  const fixture = await analyticalFixture();
  const requests = [
    {
      actor: 'ana',
      options: {
        select: ['name'],
        compute: { bad: { sql: 'DELETE FROM self.events' } },
      },
    },
    {
      actor: 'ana',
      options: {
        select: ['name'],
        compute: {
          bad: {
            sql: 'SELECT COUNT(*) FROM self.events WHERE amount > $minimum',
            parameters: {},
          },
        },
      },
    },
    {
      actor: 'fin',
      options: {
        select: ['name'],
        compute: { callerCount: { sql: 'SELECT COUNT(*) FROM self.events' } },
      },
    },
  ] as const;

  for (const { actor, options } of requests) {
    const mcp = await fixture.connect(actor);
    const embedded = await fixture.runtime
      .operations(fixture.principals[actor])
      .query('customer', options)
      .catch((error: unknown) => error);
    const remote = await mcp.execute(
      `try { await graph.objects.Customer.query(${JSON.stringify(options)}); } catch (error) { return { name: error.name, code: error.code, operation: error.operation, issues: error.issues, acceptedOptions: error.acceptedOptions }; }`,
    );

    expect(embedded).toBeInstanceOf(ReadError);

    if (!(embedded instanceof ReadError))
      throw new Error('Expected a read error');

    expect(remote).toEqual({
      name: embedded.name,
      code: 'invalid-request',
      operation: embedded.operation,
      issues: embedded.issues,
      ...(embedded.acceptedOptions
        ? { acceptedOptions: embedded.acceptedOptions }
        : {}),
    });
    expect(embedded.issues?.length).toBeGreaterThan(0);
    const uncaught = await mcp.call(
      `return await graph.objects.Customer.query(${JSON.stringify(options)});`,
    );

    expect(uncaught).toMatchObject({
      isError: true,
      structuredContent: {
        status: 'failed',
        error: { name: 'ReadError', code: 'invalid-request' },
      },
    });
  }

  expect(fixture.counters.statements).toBe(0);
  const mcp = await fixture.connect('ana');
  const request = {
    select: ['name'],
    limit: 1,
    orderBy: [{ field: 'matched', direction: 'desc' }],
    compute: {
      matched: {
        sql: 'SELECT COUNT(*) FROM self.events WHERE amount >= $minimum',
        parameters: { minimum: '1' },
      },
    },
  } as const;
  const first = await mcp.execute<PageResult>(
    `return await graph.objects.Customer.query(${JSON.stringify(request)});`,
  );

  expect(first.meta.continuationCursor).toBeDefined();
  const changed = {
    ...request,
    cursor: first.meta.continuationCursor,
    compute: {
      matched: { ...request.compute.matched, parameters: { minimum: '20' } },
    },
  };
  const result = await mcp.execute(
    `try { await graph.objects.Customer.query(${JSON.stringify(changed)}); } catch (error) { return { code: error.code, issues: error.issues }; }`,
  );

  expect(result).toMatchObject({
    code: 'invalid-request',
    issues: [{ problem: 'invalid-cursor' }],
  });
});

it('keeps driver errors private, omits optional aliases and fails required analytical values', async () => {
  const fixture = await analyticalFixture();
  const mcp = await fixture.connect('ana');

  fixture.hooks.failStatement = true;
  const optional = await mcp.execute<ObjectRecord>(
    `return await graph.objects.Customer.get('a', { select: ['name', 'count'], compute: ${JSON.stringify(compute)}, evidence: 'full' });`,
  );

  expect(optional.data).toEqual({ name: 'Acme' });

  for (const field of ['count', ...Object.keys(compute)]) {
    expect(optional.meta.fields?.[field]).toMatchObject({
      status: 'unavailable',
      reason: 'execution-failed',
    });
  }

  const required = await mcp.call(
    `return await graph.objects.Customer.query({ select: ['name'], where: { count: { gte: '1' } } });`,
  );

  expect(required).toMatchObject({
    isError: true,
    structuredContent: {
      status: 'failed',
      error: { name: 'ReadError', code: 'incomplete' },
    },
  });

  for (const value of [
    'private-driver-error',
    fixture.directory,
    'private_events',
    'event_amount',
  ]) {
    expect(JSON.stringify([optional, required])).not.toContain(value);
  }

  fixture.hooks.failStatement = false;
  expect(
    await mcp.execute<ObjectRecord>(
      `return await graph.objects.Customer.get('a', { select: ['count'] });`,
    ),
  ).toMatchObject({ data: { count: '2' } });
});

it('records analytical stages only in host activity, with no SQL, parameters or provider identity in MCP results', async () => {
  const fixture = await analyticalFixture();
  const mcp = await fixture.connect('support');
  const result = await mcp.execute<PageResult>(
    `return await graph.objects.Customer.query({ select: ['name', 'count'], compute: { privateAlias: { sql: 'SELECT COUNT(*) FROM self.events WHERE secret = $secret', parameters: { secret: 'private-one' } } }, orderBy: [{ field: 'count', direction: 'desc' }], evidence: 'full' });`,
  );

  expect(result.data[0]!.data.privateAlias).toBe('1');
  await fixture.runtime.host.flushActivity();
  const row = (
    await fixture.runtime.host.activity.operations.list()
  ).entries.find((entry) => entry.kind === 'query')!;

  expect(row.details.analytical?.stages).toMatchObject({
    preparation: { count: 1 },
    candidates: { count: 1 },
    execution: { count: 2 },
    connectionStartup: { count: 2 },
  });

  for (const value of [
    'analytical',
    'queueWait',
    'connectionStartup',
    'totalMs',
    'maxMs',
    fixture.directory,
    'private-connection',
    'private_events',
    'event_amount',
    'private-one',
    'SELECT',
  ]) {
    expect(JSON.stringify(result)).not.toContain(value);
  }

  for (const value of [
    'privateAlias',
    'private-one',
    'SELECT',
    fixture.directory,
    'private_events',
  ]) {
    expect(JSON.stringify(row)).not.toContain(value);
  }
});

it('attributes returned, forbidden and unavailable declared calculations by stable ID without recording caller aliases', async () => {
  const fixture = await analyticalFixture();
  const support = await fixture.connect('support');
  const ana = await fixture.connect('ana');
  const request = {
    select: ['count', 'privateCount'],
    compute: {
      privateCaller: { sql: 'SELECT COUNT(DISTINCT secret) FROM self.events' },
    },
  };

  await support.execute(
    `return await graph.objects.Customer.query(${JSON.stringify(request)});`,
  );
  await ana.execute(
    `return await graph.objects.Customer.query(${JSON.stringify(request)});`,
  );
  fixture.hooks.failStatement = true;
  await support.execute(
    `return await graph.objects.Customer.get('a', ${JSON.stringify(request)});`,
  );
  await fixture.runtime.host.flushActivity();
  const rows = (await fixture.runtime.host.activity.operations.list()).entries;
  const returned = rows.find(
    (row) => row.kind === 'query' && row.actor.id === 'support',
  )!;
  const forbidden = rows.find(
    (row) => row.kind === 'query' && row.actor.id === 'ana',
  )!;
  const unavailable = rows.find((row) => row.kind === 'get')!;

  expect(returned.objects).toHaveLength(3);
  expect(forbidden.objects).toHaveLength(3);
  expect(unavailable.objects).toHaveLength(1);

  for (const object of returned.objects)
    expect(object).toMatchObject({
      returned: ['customer.count', 'customer.private-count'],
      forbidden: [],
      unavailable: [],
    });

  for (const object of forbidden.objects)
    expect(object).toMatchObject({
      returned: ['customer.count'],
      forbidden: ['customer.private-count'],
      unavailable: [],
    });

  expect(unavailable.objects[0]).toMatchObject({
    returned: [],
    forbidden: [],
    unavailable: ['customer.count', 'customer.private-count'],
  });
  expect(JSON.stringify(rows)).not.toContain('privateCaller');
});
