import { afterEach, expect, it, vi } from 'vitest';
import { bind, defineApp } from 'relate';
import type { AnalyticalLimits } from 'relate/analytics';
import type {
  AnalyticalConnector,
  AuthorizedDatasetQuery,
  PreparedPlan,
} from 'relate/connectors';
import type { ObjectQueryRequest } from '@relate/protocol';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  analyticalGraphSchema,
  createAnalyticalConnector,
} from '../../../tests/support/analytical-connector.js';
import { testCreation } from '../../../tests/support/activity.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
}

/** Real public host/parser/read path; the connector records admission and execution. */
async function app(
  limits: AnalyticalLimits,
  options: { declared?: string; count?: number; onDispose?: () => void } = {},
) {
  const { graph, Events, Customer } = createAnalyticalGraph(options.declared);
  const model = compile(graph);
  const store = createMemoryStore();
  const scope = {
    graphId: graph.id,
    definitionRevision: model.definitionRevision,
  };

  await store.install(scope.graphId, scope.definitionRevision);
  await store.native!.transaction(scope, async (transaction) => {
    for (let i = 0; i < (options.count ?? 5); i++)
      await transaction.insert(
        {
          objectDefinitionId: Customer.id,
          objectId: String(i),
          createdAt: Date.now(),
          values: {
            'customer.external': String(i),
            'customer.label': String(i),
          },
        },
        testCreation(),
      );
  });
  const connector = createAnalyticalConnector(analyticalGraphSchema());
  const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
  const statements: { slots: number; timeoutMs: number }[] = [];
  const hooks: {
    execute?: (
      options: Parameters<AnalyticalConnector['execute']>[1],
    ) => Promise<void>;
  } = {};
  const reads = { count: 0 };
  const load = store.native!.load.bind(store.native!);

  store.native!.load = (...args) => {
    reads.count++;

    return load(...args);
  };
  connector.connection.analytics.plan = (query) => {
    const plan = {} as PreparedPlan;

    plans.set(plan, query);

    return plan;
  };
  connector.connection.analytics.execute = async (plan, execution) => {
    const query = plans.get(plan)!;

    statements.push({
      slots: query.slots.length,
      timeoutMs: execution.timeoutMs,
    });
    await hooks.execute?.(execution);
    execution.signal.throwIfAborted();

    return {
      readAt: new Date().toISOString(),
      rows: query.slots.map((_, slot) => ({
        slot,
        values: query.aggregates.map(() => 1n),
      })),
    };
  };
  const runtime = await startApp(
    defineApp({
      graph,
      setup({ onDispose }) {
        onDispose(options.onDispose ?? (() => {}));

        return {
          store,
          analytics: limits,
          bindings: [bind(Events, connector.table('events'))],
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
    statements,
    hooks,
    reads,
    discovery: runtime.operations(principal).discovery,
    query: (request: ObjectQueryRequest, actor = 'ana') =>
      runtime
        .operations({ ...principal, id: actor })
        .query('customer', request),
  };
}

const countSql = 'SELECT COUNT(*) FROM self.events';
const read = { select: ['count'], evidence: 'full', limit: 1 } as const;

it.each([{ maxSqlBytes: 16 }, { maxParsedNodes: 4 }])(
  'applies %j to every declaration at startup and disposes on rejection',
  async (limits) => {
    const dispose = vi.fn();

    await expect(app(limits, { onDispose: dispose })).rejects.toMatchObject({
      name: 'CompileError',
    });
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it('allows a larger SQL budget consistently in startup, discovery, declarations and caller expressions', async () => {
  const sql = `${' '.repeat(4100)}${countSql}`;
  const { query, discovery } = await app(
    { maxSqlBytes: 5000 },
    { declared: sql },
  );

  expect(
    discovery
      .describeObject('customer')
      ?.properties.find((property) => property.name === 'count'),
  ).toMatchObject({
    kind: 'computed',
    schema: { type: 'int64', nullable: false },
  });
  const result = await query({
    select: ['count'],
    compute: { caller: { sql } },
    limit: 1,
  });

  expect(result.data[0]!.data).toMatchObject({ count: '1', caller: '1' });
});

it.each([
  [{ maxSqlBytes: 64 }, { sql: `${' '.repeat(65)}${countSql}` }],
  [
    { maxParsedNodes: 20 },
    {
      sql: `${countSql} WHERE ${Array.from({ length: 20 }, () => 'amount = 1').join(' OR ')}`,
    },
  ],
  [
    { maxParameters: 1 },
    {
      sql: `${countSql} WHERE amount > $a AND amount < $b`,
      parameters: { a: '0', b: '9' },
    },
  ],
  [
    { maxParameterBytes: 5 },
    { sql: `${countSql} WHERE secret = $secret`, parameters: { secret: 'éé' } },
  ],
] as const)(
  'rejects caller expressions above %j before reading candidates',
  async (limits, expression) => {
    const { query, reads, statements } = await app(limits);

    await expect(
      query({ select: ['id'], compute: { total: expression } }),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(reads.count).toBe(0);
    expect(statements).toHaveLength(0);
  },
);

it('counts declarations and caller expressions together and permits a configured larger expression budget', async () => {
  const limited = await app({ maxExpressions: 1 });

  await expect(
    limited.query({
      select: ['count'],
      compute: { caller: { sql: countSql } },
    }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  expect(limited.statements).toHaveLength(0);
  const raised = await app({ maxExpressions: 10 });
  const compute = Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`n${i}`, { sql: countSql }]),
  );
  const result = await raised.query({ select: ['count'], compute, limit: 1 });

  expect(Object.keys(result.data[0]!.data)).toHaveLength(10);
  expect(raised.statements).toHaveLength(1);
});

it('raises the parser and resolver parameter budget together', async () => {
  const { query } = await app({ maxParameters: 17 });
  const sql = `${countSql} WHERE ${Array.from({ length: 17 }, (_, i) => `amount = $p${i}`).join(' OR ')}`;
  const parameters = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`p${i}`, String(i)]),
  );
  const result = await query({
    select: ['id'],
    compute: { caller: { sql, parameters } },
    limit: 1,
  });

  expect(result.data[0]!.data.caller).toBe('1');
});

it.each([2, 6])(
  'snapshots batch size, execution time and concurrency %s before serving',
  async (concurrency) => {
    const limits = {
      maxKeysPerStatement: 1,
      statementTimeoutMs: 37,
      maxConcurrentStatements: concurrency,
      maxQueuedStatements: 0,
    };
    const { query, statements, hooks } = await app(limits);

    Object.assign(limits, {
      maxKeysPerStatement: 100,
      statementTimeoutMs: 999,
      maxConcurrentStatements: 99,
    });
    let active = 0;
    let peak = 0;

    hooks.execute = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };
    const result = await query({
      select: ['count'],
      limit: 5,
      requireComplete: true,
    });

    expect(result.data).toHaveLength(5);
    expect(statements).toEqual(
      Array.from({ length: 5 }, () => ({ slots: 1, timeoutMs: 37 })),
    );
    expect(peak).toBe(Math.min(concurrency, 5));
  },
);

it.each([
  { maxQueuedStatements: 0, queueTimeoutMs: 2000 },
  { maxQueuedStatements: 1, queueTimeoutMs: 0 },
  { maxQueuedStatements: 1, queueTimeoutMs: 15 },
])(
  'enforces shared connection admission across actors with %j',
  async (limits) => {
    const { query, hooks, statements } = await app({
      ...limits,
      maxConcurrentStatements: 1,
    });
    const started = deferred();
    const release = deferred();

    hooks.execute = async () => {
      started.resolve();
      await release.promise;
    };
    const first = query(read, 'ana');

    try {
      await started.promise;
      const second = await query(read, 'other');

      expect(second.data[0]!.meta.fields?.count).toMatchObject({
        status: 'unavailable',
        reason: 'busy',
        retryable: true,
      });
      expect(statements).toHaveLength(1);
    } finally {
      release.resolve();
      await first;
    }

    expect((await query(read)).data[0]!.data.count).toBe('1');
  },
);

it.each([
  { maxSqlBytes: 0 },
  { maxParsedNodes: 0 },
  { maxParameters: 0 },
  { maxParameterBytes: -1 },
  { maxExpressions: NaN },
  { maxKeysPerStatement: 0 },
  { statementTimeoutMs: 2_147_483_648 },
  { maxConcurrentStatements: 0 },
  { maxQueuedStatements: -1 },
  { queueTimeoutMs: Infinity },
])(
  'rejects invalid host configuration %j and disposes setup',
  async (limits) => {
    const dispose = vi.fn();

    await expect(app(limits, { onDispose: dispose })).rejects.toThrow(
      'Invalid analytical limits',
    );
    expect(dispose).toHaveBeenCalledOnce();
  },
);

it('honors larger parsed-node and parameter-value limits without hidden default caps', async () => {
  const sql = `${countSql} WHERE ${Array.from({ length: 150 }, () => 'amount = 1').join(' OR ')} OR secret = $secret`;
  const parameters = { secret: 'x'.repeat(1025) };
  const limited = await app({});

  await expect(
    limited.query({ select: ['id'], compute: { n: { sql, parameters } } }),
  ).rejects.toMatchObject({ code: 'invalid-request' });
  const raised = await app({ maxParsedNodes: 2000, maxParameterBytes: 2048 });
  const result = await raised.query({
    select: ['id'],
    compute: { n: { sql, parameters } },
    limit: 1,
  });

  expect(result.data[0]!.data.n).toBe('1');
});
