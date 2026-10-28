import { expect, it, afterEach, vi } from 'vitest';
import { executeResolvedFields as computeFields } from '../src/analytics/execute.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { createSqlParser } from '@relate/sql-parser';
import type { FieldEvidence } from '@relate/protocol';
import type {
  AnalyticalConnector,
  AuthorizedDatasetQuery,
  DatasetExecution,
  DatasetResource,
  PreparedPlan,
  TypedValue,
} from 'relate/connectors';
import { DatasetExecutionError } from 'relate/connectors';
import {
  prepareExpression,
  createStatementQueue,
  createAnalyticalTimings,
  AnalyticalIncompleteError,
} from '../src/analytics/index.js';
import type {
  ActorAssociations,
  ResolvedCalculation,
  AuthorizedCandidate,
  AnalyticalBinding,
} from '../src/analytics/index.js';

const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();

  cleanup.length = 0;
});

function evidence(): FieldEvidence {
  return {
    status: 'available',
    source: 'native',
    observedAt: '2026-10-01T00:00:00.000Z',
    freshness: 'fresh',
    retention: 'confirmed',
    retentionDurability: 'volatile',
    ordering: 'confirmed',
    refresh: 'not-needed',
  };
}

function candidate(id: string, key = id, since?: string): AuthorizedCandidate {
  return {
    id,
    dependencies: {
      key: { value: { type: 'string', value: key }, evidence: evidence() },
      ...(since
        ? {
            since: {
              value: { type: 'timestamp', precision: 3, value: since },
              evidence: evidence(),
            },
          }
        : {}),
    },
  };
}

function scope(): ActorAssociations {
  return {
    properties: [
      {
        id: 'key',
        name: 'key',
        calculated: false,
        readable: true,
        schema: { type: 'string', nullable: false },
      },
      {
        id: 'since',
        name: 'since',
        calculated: false,
        readable: true,
        schema: { type: 'timestamp', precision: 3, nullable: true },
      },
    ],
    associations: [
      {
        id: 'customer.events',
        name: 'events',
        datasetDefinitionId: 'events',
        on: [{ columnDefinitionId: 'events.key', propertyDefinitionId: 'key' }],
        columns: [
          {
            id: 'events.key',
            name: 'customerId',
            readable: true,
            schema: { type: 'string', nullable: false },
          },
          {
            id: 'events.amount',
            name: 'amount',
            readable: true,
            schema: { type: 'int64', nullable: true },
          },
          {
            id: 'events.at',
            name: 'at',
            readable: true,
            schema: { type: 'timestamp', precision: 3, nullable: true },
          },
        ],
      },
    ],
  };
}

async function field(
  name: string,
  sql = 'SELECT COUNT(*) FROM self.events',
  options: Partial<Omit<ResolvedCalculation, 'name' | 'expression'>> = {},
): Promise<ResolvedCalculation> {
  return {
    name,
    expression: prepareExpression({
      parser: await createSqlParser(),
      scope: scope(),
      expression: { sql },
    }),
    readable: true,
    project: true,
    required: false,
    ...options,
  };
}

function mockBinding(
  execute?: (
    query: AuthorizedDatasetQuery,
    signal: AbortSignal,
  ) => Promise<DatasetExecution>,
) {
  const planned: AuthorizedDatasetQuery[] = [];
  const executions: AuthorizedDatasetQuery[] = [];
  const handles = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
  const queue = createStatementQueue();

  cleanup.push(() => queue.retire());
  const connector: AnalyticalConnector = {
    limits: { maxParameters: 32766 },
    async describe() {
      return { columns: {} };
    },
    parameterBudget(query) {
      return {
        fixed: 0,
        perSlot: 1 + query.keys.length + query.aggregates.length,
      };
    },
    plan(query) {
      planned.push(query);
      const handle = {} as PreparedPlan;

      handles.set(handle, query);

      return handle;
    },
    async execute(handle, { signal, onTiming }) {
      signal.throwIfAborted();
      const query = handles.get(handle)!;

      executions.push(query);
      onTiming?.({ stage: 'connectionStartup', durationMs: 2 });

      try {
        return execute
          ? await execute(query, signal)
          : {
              readAt: '2026-10-21T00:00:00.000Z',
              rows: query.slots.map((_, slot) => ({
                slot,
                values: query.aggregates.map(() => 2n),
                checks: query.aggregates.map(() => ({
                  arithmeticFailed: false,
                })),
              })),
            };
      } finally {
        onTiming?.({ stage: 'execution', durationMs: 3 });
      }
    },
  };
  const binding: AnalyticalBinding = {
    resource: {} as DatasetResource,
    connector,
    queue,
    bindingRevision: 'binding:test',
  };

  return { binding, planned, executions };
}

const signal = () => new AbortController().signal;

it('executes real SQLite batches with duplicate keys, remapped self dependencies and per-alias masks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relate-compute-'));

  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'events.sqlite');
  const db = new DatabaseSync(path);

  db.exec(
    "CREATE TABLE events(customer_id TEXT NOT NULL, amount INTEGER, at TEXT); INSERT INTO events VALUES ('acme', 9007199254740993, '2026-10-01T00:00:00.000Z'), ('acme', 2, '2026-10-02T00:00:00.000Z')",
  );
  db.close();
  const connection = sqlite({ connectionId: 'sqlite', path });

  cleanup.push(() => connection.close());
  const queue = createStatementQueue();

  cleanup.push(() => queue.retire());
  const resource = connection.table('events').bindDataset({
    columns: { customerId: 'customer_id', amount: 'amount', at: 'at' },
  });
  const planned: AuthorizedDatasetQuery[] = [];
  const binding: AnalyticalBinding = {
    resource,
    connector: {
      ...connection.analytics,
      plan(query) {
        planned.push(query);

        return connection.analytics.plan(query);
      },
    },
    queue,
    bindingRevision: 'sqlite:one',
  };
  const fields = [
    await field(
      'sinceCount',
      'SELECT COUNT(*) FROM self.events WHERE at >= self.since',
    ),
    await field('count'),
    await field('sum', 'SELECT SUM(amount) FROM self.events', {
      definitionId: 'customer.sum',
    }),
  ];
  const timings = createAnalyticalTimings();
  const result = await computeFields({
    fields,
    candidates: [
      candidate('first', 'acme', '2026-10-01T00:00:00.000Z'),
      candidate('second', 'acme', '2026-10-02T00:00:00.000Z'),
      candidate('missing', 'acme'),
      candidate('empty', 'empty', '2026-10-01T00:00:00.000Z'),
    ],
    binding: () => binding,
    signal: signal(),
    maxSlots: 2,
    timings,
  });

  expect(planned).toHaveLength(2);
  expect(planned.map((query) => query.slots.length)).toEqual([2, 2]);
  expect(planned[1]!.slots[0]!.valid).toEqual([false, true, true]);
  expect(planned[1]!.slots[0]!.values[1]).toEqual({
    type: 'timestamp',
    precision: 3,
    value: null,
  });
  expect(result.rows.get('first')!.sinceCount).toMatchObject({
    status: 'available',
    value: '2',
  });
  expect(result.rows.get('second')!.sinceCount).toMatchObject({
    status: 'available',
    value: '1',
  });
  expect(result.rows.get('missing')!.sinceCount).toEqual({
    status: 'unavailable',
    reason: 'correlation-unavailable',
  });
  expect(result.rows.get('missing')!.sum).toMatchObject({
    status: 'available',
    value: '9007199254740995',
  });
  expect(result.rows.get('empty')!.sum).toMatchObject({
    status: 'available',
    value: null,
  });
  expect(result.rows.get('empty')!.count).toMatchObject({
    status: 'available',
    value: '0',
  });
  const successful = result.rows.get('second')!.sinceCount;

  expect(successful).toMatchObject({
    input: {
      associationId: 'customer.events',
      datasetId: 'events',
      bindingRevision: 'sqlite:one',
    },
    dependencies: {
      since: {
        value: {
          type: 'timestamp',
          precision: 3,
          value: '2026-10-02T00:00:00.000Z',
        },
      },
    },
  });
  expect(result.results.sum).toEqual({ type: 'int64', nullable: true });
  expect(timings.snapshot().stages.execution!.count).toBe(2);
  expect(timings.snapshot().stages.queueWait!.count).toBe(2);
  expect(JSON.stringify(timings.snapshot())).not.toMatch(
    /acme|sqlite:one|SELECT|sinceCount/,
  );
});

it('uses connector parameter sizing to reduce batch size before execution', async () => {
  const mock = mockBinding();

  const binding = {
    ...mock.binding,
    connector: { ...mock.binding.connector, limits: { maxParameters: 8 } },
  };
  const result = await computeFields({
    fields: [await field('one')],
    candidates: ['a', 'b', 'c', 'd', 'e'].map((id) => candidate(id)),
    binding: () => binding,
    signal: signal(),
  });

  expect(mock.planned.map((query) => query.slots.length)).toEqual([2, 2, 1]);
  expect(result.rows.size).toBe(5);
});

it('withdraws a logically invalid alias across the full scope while preserving other aliases', async () => {
  const mock = mockBinding(async (query) => ({
    readAt: '2026-10-21T00:00:00.000Z',
    rows: query.slots.map((slot, i) => ({
      slot: i,
      values: [slot.values[0]!.value === 'bad' ? 'wrong' : 2n, 5n],
      checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
    })),
  }));
  const result = await computeFields({
    fields: [await field('badAlias'), await field('goodAlias')],
    candidates: [candidate('first'), candidate('bad'), candidate('last')],
    binding: () => mock.binding,
    signal: signal(),
    maxSlots: 1,
  });

  for (const fields of result.rows.values()) {
    expect(fields.badAlias).toEqual({
      status: 'unavailable',
      reason: 'invalid-result',
    });
    expect(fields.goodAlias).toMatchObject({ status: 'available', value: '5' });
  }
});

it('withdraws only the failed cell on an arithmetic check, never the whole alias', async () => {
  const mock = mockBinding(async (query) => ({
    readAt: '2026-10-21T00:00:00.000Z',
    rows: query.slots.map((slot, i) => {
      const bad = slot.values[0]!.value === 'bad';

      return {
        slot: i,
        // A failed cell's placeholder is null even for a non-null result type.
        values: [bad ? null : 2n, 5n],
        checks: [{ arithmeticFailed: bad }, { arithmeticFailed: false }],
      };
    }),
  }));
  const result = await computeFields({
    fields: [await field('checked'), await field('sibling')],
    candidates: [candidate('first'), candidate('bad'), candidate('last')],
    binding: () => mock.binding,
    signal: signal(),
    maxSlots: 1,
  });

  expect(result.rows.get('bad')).toMatchObject({
    checked: {
      status: 'unavailable',
      reason: 'execution-failed',
      retryable: false,
    },
    sibling: { status: 'available', value: '5' },
  });

  for (const id of ['first', 'last'])
    expect(result.rows.get(id)).toMatchObject({
      checked: { status: 'available', value: '2' },
      sibling: { status: 'available', value: '5' },
    });
});

it('withdraws every alias in a failed statement across earlier and later batches', async () => {
  const mock = mockBinding(async (query) => {
    if (query.slots[0]!.values[0]!.value === 'bad')
      throw new DatasetExecutionError('execution-failed', {
        retryable: false,
        cause: new Error('SELECT secret'),
      });

    return {
      readAt: '2026-10-21T00:00:00.000Z',
      rows: [
        {
          slot: 0,
          values: [1n, 2n],
          checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
        },
      ],
    };
  });
  const result = await computeFields({
    fields: [await field('one'), await field('two')],
    candidates: [candidate('first'), candidate('bad'), candidate('last')],
    binding: () => mock.binding,
    signal: signal(),
    maxSlots: 1,
  });

  for (const fields of result.rows.values())
    for (const field of Object.values(fields))
      expect(field).toEqual({
        status: 'unavailable',
        reason: 'execution-failed',
        retryable: false,
      });

  expect(JSON.stringify([...result.rows])).not.toContain('SELECT');
});

it.each([
  {
    readAt: 'invalid',
    rows: [
      {
        slot: 0,
        values: [1n, 2n],
        checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
      },
    ],
  },
  { readAt: '2026-10-21T00:00:00.000Z', rows: [] },
  {
    readAt: '2026-10-21T00:00:00.000Z',
    rows: [
      {
        slot: 1,
        values: [1n, 2n],
        checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
      },
    ],
  },
  {
    readAt: '2026-10-21T00:00:00.000Z',
    rows: [{ slot: 0, values: [1n], checks: [{ arithmeticFailed: false }] }],
  },
  {
    readAt: '2026-10-21T00:00:00.000Z',
    rows: [
      {
        slot: 0,
        values: [1n, {}],
        checks: [{ arithmeticFailed: false }, { arithmeticFailed: false }],
      },
    ],
  },
  { readAt: '2026-10-21T00:00:00.000Z', rows: [{ slot: 0, values: [1n, 2n] }] },
  {
    readAt: '2026-10-21T00:00:00.000Z',
    rows: [
      { slot: 0, values: [1n, 2n], checks: [{ arithmeticFailed: false }] },
    ],
  },
  {
    readAt: '2026-10-21T00:00:00.000Z',
    rows: [
      {
        slot: 0,
        values: [1n, 2n],
        checks: [{ arithmeticFailed: false }, { arithmeticFailed: 1 }],
      },
    ],
  },
])(
  'treats malformed result framing as a statement-wide failure %#',
  async (result) => {
    const mock = mockBinding(async () => result as unknown as DatasetExecution);
    const scope = await computeFields({
      fields: [await field('one'), await field('two')],
      candidates: [candidate('one')],
      binding: () => mock.binding,
      signal: signal(),
    });

    expect(Object.values(scope.rows.get('one')!)).toEqual([
      { status: 'unavailable', reason: 'invalid-result' },
      { status: 'unavailable', reason: 'invalid-result' },
    ]);
  },
);

it('does not execute fields with denied columns, missing correlation or denied self inputs', async () => {
  const mock = mockBinding();
  const count = await field('count');
  const filtered = await field(
    'filtered',
    'SELECT COUNT(*) FROM self.events WHERE at >= self.since',
  );
  const deniedColumn = {
    ...count,
    name: 'deniedColumn',
    expression: { ...count.expression, forbidden: true },
  };
  const deniedKey = {
    ...count,
    name: 'deniedKey',
    expression: { ...count.expression, correlationForbidden: true },
  };
  const deniedProperty = { ...count, name: 'deniedProperty', readable: false };
  const deniedSelf = {
    ...candidate('denied'),
    dependencies: {
      ...candidate('denied').dependencies,
      since: { evidence: { status: 'forbidden' as const } },
    },
  };
  const result = await computeFields({
    fields: [count, filtered, deniedColumn, deniedKey, deniedProperty],
    candidates: [deniedSelf, { id: 'missing', dependencies: {} }],
    binding: () => mock.binding,
    signal: signal(),
  });

  expect(mock.planned).toHaveLength(1);
  expect(mock.planned[0]!.aggregates).toHaveLength(1);
  expect(result.rows.get('denied')!.filtered).toEqual({ status: 'forbidden' });
  expect(result.rows.get('denied')!.deniedKey).toEqual({
    status: 'unavailable',
    reason: 'correlation-unavailable',
  });
  expect(result.rows.get('denied')!.deniedColumn).toEqual({
    status: 'forbidden',
  });
  expect(result.rows.get('denied')!.deniedProperty).toEqual({
    status: 'forbidden',
  });
  expect(result.rows.get('missing')!.count).toEqual({
    status: 'unavailable',
    reason: 'correlation-unavailable',
  });
});

it('keeps filter-only declarations out of projection metadata and enforces required fields', async () => {
  const mock = mockBinding();
  const hidden = await field(
    'threshold',
    'SELECT COUNT(*) FROM self.events WHERE at >= self.since',
    { definitionId: 'customer.threshold', project: false, required: true },
  );

  await expect(
    computeFields({
      fields: [hidden],
      candidates: [candidate('missing')],
      binding: () => mock.binding,
      signal: signal(),
    }),
  ).rejects.toBeInstanceOf(AnalyticalIncompleteError);
  const result = await computeFields({
    fields: [hidden],
    candidates: [candidate('present', 'a', '2026-10-01T00:00:00.000Z')],
    binding: () => mock.binding,
    signal: signal(),
  });

  expect(result.results).toEqual({});
  expect(result.rows.get('present')!.threshold!.status).toBe('available');
  await expect(
    computeFields({
      fields: [{ ...hidden, required: false, project: true }],
      candidates: [candidate('missing')],
      binding: () => mock.binding,
      signal: signal(),
      requireComplete: true,
    }),
  ).rejects.toMatchObject({
    fields: { threshold: { reason: 'correlation-unavailable' } },
  });
});

it('skips all database work for an empty population while retaining projected result metadata', async () => {
  const count = await field('count');
  const result = await computeFields({
    fields: [count],
    candidates: [],
    binding: () => {
      throw new Error('Should not bind');
    },
    signal: signal(),
  });

  expect(result.rows.size).toBe(0);
  expect(result.results).toEqual({ count: { type: 'int64', nullable: false } });
});

it('waits for every active statement cleanup on cancellation and does not start more batches', async () => {
  const pending: { signal: AbortSignal; release: () => void }[] = [];
  const mock = mockBinding(async (_, signal) => {
    await new Promise<void>((release) => pending.push({ signal, release }));

    return {
      readAt: '2026-10-21T00:00:00.000Z',
      rows: [{ slot: 0, values: [1n], checks: [{ arithmeticFailed: false }] }],
    };
  });
  const controller = new AbortController();
  const capture = createAnalyticalTimings();
  let settled = false;
  const work = computeFields({
    fields: [await field('count')],
    candidates: Array.from({ length: 9 }, (_, i) => candidate(String(i))),
    binding: () => mock.binding,
    signal: controller.signal,
    maxSlots: 1,
    timings: capture,
  });
  const outcome = work.then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;

      return error;
    },
  );

  await vi.waitFor(() => expect(pending).toHaveLength(4));
  const reason = new Error('caller cancelled');

  controller.abort(reason);
  expect(pending.every((entry) => entry.signal.aborted)).toBe(true);
  pending[0]!.release();
  await Promise.resolve();
  expect(settled).toBe(false);

  for (const entry of pending.slice(1)) entry.release();

  expect(await outcome).toBe(reason);
  expect(mock.executions).toHaveLength(4);
  expect(capture.snapshot().stages.execution!.count).toBe(4);
  expect(capture.snapshot().stages).not.toHaveProperty('finalization');
});

it('rejects cancellation during finalization before returning a completed scope', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled at completion');

  await expect(
    computeFields({
      fields: [await field('count')],
      candidates: [],
      binding: () => {
        throw new Error('not reached');
      },
      signal: controller.signal,
      timings: {
        record() {},
        begin(stage) {
          return () => {
            if (stage === 'finalization') controller.abort(reason);
          };
        },
      },
    }),
  ).rejects.toBe(reason);
});

it('validates parameter budgets for all associations before any statement executes', async () => {
  const mock = mockBinding();
  const first = await field('first');
  const second = await field('second');
  const tooLarge: AnalyticalBinding = {
    ...mock.binding,
    connector: {
      ...mock.binding.connector,
      parameterBudget: () => ({ fixed: 32766, perSlot: 1 }),
    },
  };

  await expect(
    computeFields({
      fields: [
        first,
        {
          ...second,
          expression: {
            ...second.expression,
            association: {
              ...second.expression.association,
              id: 'second',
              datasetDefinitionId: 'too-large',
            },
          },
        },
      ],
      candidates: [candidate('one')],
      binding: (id) => (id === 'too-large' ? tooLarge : mock.binding),
      signal: signal(),
    }),
  ).rejects.toMatchObject({ issues: [{ problem: 'not-supported' }] });
  expect(mock.planned).toHaveLength(0);
  expect(mock.executions).toHaveLength(0);
});

it('snapshots ordinary values and evidence before starting provider work', async () => {
  const original = candidate('one');
  const mock = mockBinding(async () => {
    Object.assign(original.dependencies.key!.value!, { value: 'changed' });
    Object.assign(original.dependencies.key!.evidence, { status: 'forbidden' });

    return {
      readAt: '2026-10-21T00:00:00.000Z',
      rows: [{ slot: 0, values: [1n], checks: [{ arithmeticFailed: false }] }],
    };
  });
  const result = await computeFields({
    fields: [await field('count')],
    candidates: [original],
    binding: () => mock.binding,
    signal: signal(),
  });

  expect(result.rows.get('one')!.count).toMatchObject({
    status: 'available',
    dependencies: {
      key: {
        value: { type: 'string', value: 'one' },
        evidence: { status: 'available' },
      },
    },
  });
});
