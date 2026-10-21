import { expect, it } from 'vitest';
import type { FeedEntry, Operation } from '@relate/protocol';
import {
  activityEventSchema,
  type OperationContext,
  type OperationEvent,
} from '@relate/inspector/protocol';
import {
  createActivityLog,
  observeDispatch,
  projectActivity,
} from '../src/index.js';

const runtimeId = 'runtime-1';

function request(requestId = 'request-1'): OperationContext {
  return {
    requestId,
    runtimeId,
    definitionRevision: 'rev',
    principal: 'alice',
    transport: 'mcp',
    executionId: 'execution-1',
  };
}

/** A dev request the log holds: the call event that opens it. */
function openRequest(
  log: ReturnType<typeof createActivityLog>,
  requestId = 'request-1',
) {
  log.record({
    kind: 'call',
    requestId,
    runtimeId,
    source: 'external',
    principal: 'alice',
    tool: 'execute',
    at: new Date(0).toISOString(),
    status: 'running',
  });
}

function query(
  id: string,
  overrides: Partial<Operation> = {},
  requestId = 'request-1',
): Operation {
  return {
    schemaVersion: 1,
    id,
    graphId: 'graph',
    definitionRevision: 'rev',
    actor: { kind: 'principal', id: 'alice' },
    context: {
      requestId,
      transport: 'mcp',
      runtimeId,
      executionId: 'execution-1',
    },
    startedAt: new Date(1).toISOString(),
    completedAt: new Date(2).toISOString(),
    durationMs: 1,
    recordedAt: new Date(3).toISOString(),
    kind: 'query',
    definitionId: 'notes.note',
    outcome: { status: 'ok' },
    objects: [
      {
        objectDefinitionId: 'notes.note',
        objectId: 'n1',
        role: 'returned',
        returned: ['note.body'],
        forbidden: ['note.secret'],
        unavailable: [],
      },
    ],
    details: { hasMore: false },
    ...overrides,
  } as Operation;
}

const operations = (log: ReturnType<typeof createActivityLog>) =>
  log
    .snapshot()
    .filter((event): event is OperationEvent => event.kind === 'operation');

it('merges the runtime record into its dispatch event in either order', () => {
  for (const runtimeFirst of [false, true]) {
    const log = createActivityLog();

    openRequest(log);
    const dispatch = observeDispatch(log, {
      opId: 'op-1',
      context: request(),
      operation: 'query',
      args: ['notes.note', { where: { body: 'preview' }, limit: 5 }],
    });

    if (runtimeFirst)
      projectActivity(log, runtimeId, {
        feed: [],
        operations: [query('op-1')],
      });

    dispatch.succeeded();

    if (!runtimeFirst)
      projectActivity(log, runtimeId, {
        feed: [],
        operations: [query('op-1')],
      });

    const [event] = operations(log);

    expect(operations(log)).toHaveLength(1);
    expect(event).toMatchObject({
      opId: 'op-1',
      op: 'query',
      status: 'succeeded',
      // The dispatch side keeps the caller's request preview...
      request: { where: '{"body":"preview"}', limit: 5 },
      // ...the runtime side supplies the outcome and lineage.
      outcome: { records: 1, hasMore: false },
      recordIds: ['n1'],
      runtime: {
        record: 'attempt',
        outcome: 'ok',
        forbidden: ['note.secret'],
      },
    });
    expect(activityEventSchema.safeParse(event).success).toBe(true);
  }
});

it('keeps the runtime outcome over a later transport answer, and the transport error detail', () => {
  const log = createActivityLog();

  openRequest(log);
  const dispatch = observeDispatch(log, {
    opId: 'op-1',
    context: request(),
    operation: 'query',
    args: ['notes.note', { limit: Number.NaN }],
  });
  const rejected = query('op-1', {
    outcome: { status: 'rejected', code: 'invalid-request' },
    objects: [],
    details: {},
  });

  projectActivity(log, runtimeId, { feed: [], operations: [rejected] });
  dispatch.failed(
    Object.assign(new Error('limit must be finite'), {
      code: 'invalid-request',
    }),
  );

  expect(operations(log)[0]).toMatchObject({
    status: 'failed',
    outcome: {
      error: { code: 'invalid-request', message: 'limit must be finite' },
    },
    runtime: { outcome: 'rejected', code: 'invalid-request' },
  });
});

it('shows nested refreshes and committed entries only within a request the log holds', () => {
  const log = createActivityLog();
  const refresh = query('refresh-1', {
    kind: 'refresh',
    parentOperationId: 'op-1',
    definitionId: 'crm.customer',
    target: { objectDefinitionId: 'crm.customer', objectId: 'c1' },
    outcome: { status: 'ok' },
    details: { refresh: 'changed' },
  } as Partial<Operation>);
  const change = {
    schemaVersion: 1,
    id: 'change-1',
    graphId: 'graph',
    definitionRevision: 'rev',
    position: '7',
    kind: 'updated',
    object: { objectDefinitionId: 'crm.customer', objectId: 'c1' },
    changedPropertyIds: ['customer.name'],
    sourceDefinitionId: 'crm.customers',
    operationId: 'refresh-1',
    parentOperationId: 'op-1',
    actor: { kind: 'source', id: 'crm.customers' },
    triggeredBy: { kind: 'principal', id: 'alice' },
    context: refresh.context,
    occurredAt: new Date(4).toISOString(),
    recordedAt: new Date(5).toISOString(),
  } as FeedEntry;
  const elsewhere = query('seed-1', {}, 'seed-request');

  // Before any dev request: nothing to show them under.
  projectActivity(log, runtimeId, {
    feed: [change],
    operations: [refresh, elsewhere],
  });
  expect(operations(log)).toEqual([]);

  openRequest(log);
  projectActivity(log, runtimeId, {
    feed: [change],
    operations: [refresh, elsewhere],
  });

  expect(operations(log)).toMatchObject([
    {
      opId: 'refresh-1',
      op: 'refresh',
      runtime: { parentOperationId: 'op-1', refresh: 'changed' },
    },
    {
      opId: 'change-1',
      op: 'updated',
      // Shown under the principal whose read triggered it.
      context: { principal: 'alice' },
      recordIds: ['c1'],
      runtime: {
        record: 'committed',
        position: '7',
        actor: { kind: 'source', id: 'crm.customers' },
        triggeredBy: { kind: 'principal', id: 'alice' },
        changedPropertyIds: ['customer.name'],
      },
    },
  ]);

  for (const event of log.snapshot())
    expect(activityEventSchema.safeParse(event).success).toBe(true);
});

it('keeps the runtime record of an event over the size budget', () => {
  const log = createActivityLog();

  openRequest(log);
  const dispatch = observeDispatch(log, {
    opId: 'op-1',
    context: request(),
    operation: 'query',
    args: [
      'notes.note',
      { select: Array.from({ length: 50 }, () => 's'.repeat(250)) },
    ],
  });
  const many = Array.from({ length: 300 }, (_, index) => ({
    objectDefinitionId: 'notes.note',
    objectId: `n${index}`.padEnd(300, 'x'),
    role: 'returned' as const,
    returned: [],
    forbidden: [`note.${'f'.repeat(300)}-${index}`],
    unavailable: [],
  }));

  dispatch.succeeded();
  projectActivity(log, runtimeId, {
    feed: [],
    operations: [query('op-1', { objects: many })],
  });

  const [event] = operations(log);

  expect(JSON.stringify(event).length).toBeLessThanOrEqual(64 * 1024);
  // Over budget: request details and record IDs go, the runtime record stays.
  expect(event!.recordIds).toEqual([]);
  expect(event!.request).toEqual({});
  expect(event).toMatchObject({
    status: 'succeeded',
    runtime: { record: 'attempt', outcome: 'ok' },
  });
  expect(activityEventSchema.safeParse(event).success).toBe(true);
});

it('preserves bounded host analytical timings in Inspector activity without adding them to request or outcome', () => {
  const log = createActivityLog();

  openRequest(log);
  const analytical = {
    stages: { execution: { count: 2, totalMs: 17, maxMs: 12 } },
  };

  projectActivity(log, runtimeId, {
    feed: [],
    operations: [query('timed', { details: { analytical } })],
  });
  const event = operations(log)[0]!;

  expect(event.runtime!.analytical).toEqual(analytical);
  expect(event.ms).toBe(1);
  expect(activityEventSchema.parse(event).kind).toBe('operation');
  expect(JSON.stringify(event.outcome)).not.toContain('totalMs');
  expect(JSON.stringify(event.request)).not.toContain('totalMs');
  const invalid = {
    ...event,
    runtime: {
      ...event.runtime,
      analytical: {
        stages: { arbitraryAlias: { count: 1, totalMs: 1, maxMs: 1 } },
      },
    },
  };

  expect(activityEventSchema.safeParse(invalid).success).toBe(false);
});
