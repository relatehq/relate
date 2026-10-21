import { describe, expect, it } from 'vitest';
import {
  describeAcceptedChange,
  validateFeedDraft,
  validateOperationDraft,
} from '@relate/runtime/storage';
import type {
  Observation,
  OperationDraft,
  FeedDraft,
} from '@relate/runtime/storage';
import { createMemoryStore } from '@relate/runtime';
import { createOperationRecorder } from '../src/activity/recorder.js';
import { uuidv7 } from '../src/activity/ids.js';
import { createCapture } from '../src/activity/capture.js';
import {
  createOperationScope,
  operationDiagnostics,
} from '../src/activity/scope.js';

function observation(
  values: Record<string, string>,
  overrides: Partial<Observation> = {},
): Observation {
  return {
    state: 'present',
    raw: { ...values },
    values,
    observedAt: 1,
    token: '1',
    ...overrides,
  };
}

function operation(overrides: Record<string, unknown> = {}): OperationDraft {
  return {
    schemaVersion: 1,
    id: uuidv7(),
    graphId: 'graph',
    definitionRevision: 'revision',
    actor: { kind: 'principal', id: 'ana' },
    context: { requestId: 'req', transport: 'embedded' },
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1,
    objects: [],
    kind: 'get',
    definitionId: 'business.customer',
    target: { objectDefinitionId: 'business.customer', objectId: 'cus_01' },
    outcome: { status: 'ok' },
    details: {},
    ...overrides,
  } as OperationDraft;
}

function change(overrides: Record<string, unknown> = {}): FeedDraft {
  return {
    schemaVersion: 1,
    id: uuidv7(),
    graphId: 'graph',
    definitionRevision: 'revision',
    kind: 'updated',
    object: { objectDefinitionId: 'business.customer', objectId: 'cus_01' },
    changedPropertyIds: ['business.customer.name'],
    operationId: uuidv7(),
    actor: { kind: 'source', id: 'crm.customers' },
    triggeredBy: { kind: 'principal', id: 'fin' },
    context: { requestId: 'req', transport: 'embedded' },
    occurredAt: new Date(0).toISOString(),
    sourceDefinitionId: 'crm.customers',
    ...overrides,
  } as FeedDraft;
}

describe('describeAcceptedChange', () => {
  it('classifies first membership as adoption with every property', () => {
    expect(
      describeAcceptedChange(undefined, observation({ b: '1', a: '2' })),
    ).toEqual({ kind: 'adopted', changedPropertyIds: ['a', 'b'] });
  });

  it('reports changed and removed mapped properties in ID order', () => {
    expect(
      describeAcceptedChange(
        observation({ name: 'Mothlight', city: 'Oslo' }),
        observation({ name: 'Mothlight Studio', revenue: '10' }),
      ),
    ).toEqual({
      kind: 'updated',
      changedPropertyIds: ['city', 'name', 'revenue'],
    });
  });

  it('ignores raw-only changes and freshness', () => {
    expect(
      describeAcceptedChange(
        observation({ name: 'Mothlight' }),
        observation(
          { name: 'Mothlight' },
          {
            raw: { name: 'Mothlight', unmapped: 'x' },
            token: '9',
            observedAt: 9,
          },
        ),
      ),
    ).toBeUndefined();
  });

  it('classifies deletion and restoration without properties', () => {
    const deleted = observation({}, { state: 'deleted', raw: {} });

    expect(
      describeAcceptedChange(observation({ name: 'Mothlight' }), deleted),
    ).toEqual({ kind: 'deleted', changedPropertyIds: [] });
    expect(
      describeAcceptedChange(deleted, observation({ name: 'Mothlight' })),
    ).toEqual({ kind: 'restored', changedPropertyIds: [] });
    expect(describeAcceptedChange(deleted, deleted)).toBeUndefined();
  });
});

describe('activity draft validation', () => {
  it('rejects fields belonging to another operation variant', () => {
    expect(() => validateOperationDraft(operation())).not.toThrow();
    expect(() =>
      validateOperationDraft(operation({ details: { refresh: 'changed' } })),
    ).toThrow(/details/);
    expect(() =>
      validateOperationDraft(
        operation({
          kind: 'invoke',
          target: undefined,
          definitionId: 'business.review',
          outcome: { status: 'succeeded' },
          replayed: true,
        }),
      ),
    ).toThrow(/invocation/);
    expect(() =>
      validateOperationDraft(
        operation({
          kind: 'query',
          target: undefined,
          outcome: { status: 'rejected', code: 'invalid-request' },
          details: { hasMore: false },
        }),
      ),
    ).toThrow(/hasMore/);
  });

  it('accepts only bounded fixed-stage analytical summaries on get and query', () => {
    const timing = { count: 2, totalMs: 12, maxMs: 7 };
    const analytical = { stages: { execution: timing } };

    expect(() =>
      validateOperationDraft(operation({ details: { analytical } })),
    ).not.toThrow();

    for (const invalid of [
      { stages: { sql: timing } },
      { stages: { execution: { ...timing, count: 0 } } },
      { stages: { execution: { ...timing, count: Infinity } } },
      { stages: { execution: { ...timing, totalMs: NaN } } },
      { stages: { execution: { ...timing, totalMs: Infinity } } },
      { stages: { execution: { ...timing, maxMs: -1 } } },
      { stages: { execution: { ...timing, maxMs: 13 } } },
      { stages: { execution: { ...timing, alias: 'private' } } },
      { stages: {}, parameters: {} },
    ])
      expect(() =>
        validateOperationDraft(operation({ details: { analytical: invalid } })),
      ).toThrow();

    expect(() =>
      validateOperationDraft(
        operation({ kind: 'receipt', details: { analytical } }),
      ),
    ).toThrow(/analytical/);
  });

  it('enforces source and trigger attribution on changes', () => {
    expect(() => validateFeedDraft(change())).not.toThrow();
    expect(() =>
      validateFeedDraft(change({ actor: { kind: 'principal', id: 'fin' } })),
    ).toThrow(/actor/);
    expect(() => validateFeedDraft(change({ triggeredBy: undefined }))).toThrow(
      /trigger/,
    );
    expect(() =>
      validateFeedDraft(change({ kind: 'created', triggeredBy: undefined })),
    ).toThrow(/source/);
    expect(() =>
      validateFeedDraft(
        change({
          kind: 'deleted',
          changedPropertyIds: ['business.customer.name'],
        }),
      ),
    ).toThrow(/properties/);
    expect(() =>
      validateFeedDraft(
        change({
          context: { requestId: 'req', transport: 'embedded', note: 'x' },
        }),
      ),
    ).toThrow(/context/);
  });

  it('requires a failure code exactly for failed invocation events', () => {
    const event = {
      schemaVersion: 1,
      id: uuidv7(),
      graphId: 'graph',
      definitionRevision: 'revision',
      kind: 'invocation-succeeded',
      actionDefinitionId: 'business.review',
      invocationId: 'inv_01',
      operationId: uuidv7(),
      actor: { kind: 'principal', id: 'ana' },
      context: { requestId: 'req', transport: 'embedded' },
      occurredAt: new Date(0).toISOString(),
    };

    expect(() => validateFeedDraft(event)).not.toThrow();
    expect(() => validateFeedDraft({ ...event, failureCode: 'x' })).toThrow();
    expect(() =>
      validateFeedDraft({ ...event, kind: 'invocation-failed' }),
    ).toThrow();
  });
});

describe('operation recorder', () => {
  it('keeps one append in flight, never retries and reports drops', async () => {
    const batches: OperationDraft[][] = [];
    let finish!: () => void;
    const reasons: string[] = [];
    const recorder = createOperationRecorder({
      graphId: 'graph',
      store: {
        atomicFeed: { sourceAcceptance: true, nativeTransactions: true },
        appendOperations: async (_graph, drafts) => {
          batches.push([...drafts]);

          if (batches.length === 1)
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
          else throw new Error('append failed');
        },
        feed: {
          read: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
        operations: {
          list: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
      },
      capture: {
        queueEntries: 3,
        batchEntries: 2,
        onDiagnostic: (diagnostic) => {
          if (diagnostic.type === 'dropped') reasons.push(diagnostic.reason);
        },
      },
    });

    recorder.record(operation());
    await new Promise((resolve) => setImmediate(resolve));
    expect(batches).toHaveLength(1);

    for (let index = 0; index < 4; index++) recorder.record(operation());

    // One in flight plus two queued fill the bound; the rest are dropped.
    expect(recorder.counters().dropped['queue-full']).toBe(2);
    expect(batches).toHaveLength(1);
    finish();
    expect(await recorder.drain(1_000)).toBe('drained');
    expect(batches.map((batch) => batch.length)).toEqual([1, 2]);
    expect(recorder.counters()).toMatchObject({
      enqueued: 3,
      appended: 1,
      dropped: { 'queue-full': 2, 'append-failed': 2 },
    });
    expect(reasons).toEqual(['queue-full', 'queue-full', 'append-failed']);
    recorder.record(operation());
    expect(recorder.counters().dropped.shutdown).toBe(1);
  });

  it('abandons queued rows at the drain deadline behind a hung append', async () => {
    const recorder = createOperationRecorder({
      graphId: 'graph',
      store: {
        atomicFeed: { sourceAcceptance: true, nativeTransactions: true },
        appendOperations: () => new Promise<void>(() => {}),
        feed: {
          read: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
        operations: {
          list: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
      },
      capture: { batchEntries: 1 },
    });

    recorder.record(operation());
    await new Promise((resolve) => setImmediate(resolve));
    recorder.record(operation());
    expect(await recorder.drain(20)).toBe('abandoned');
    expect(recorder.counters().dropped.shutdown).toBe(1);
  });

  it('flushes appended rows without closing', async () => {
    const appended: OperationDraft[] = [];
    let finish!: () => void;
    const recorder = createOperationRecorder({
      graphId: 'graph',
      store: {
        atomicFeed: { sourceAcceptance: true, nativeTransactions: true },
        appendOperations: async (_graph, drafts) => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          appended.push(...drafts);
        },
        feed: {
          read: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
        operations: {
          list: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
      },
    });

    recorder.record(operation());
    expect(await recorder.flush(20)).toBe('pending');
    finish();
    expect(await recorder.flush(1_000)).toBe('flushed');
    expect(appended).toHaveLength(1);
    // Still open: later operations are captured, not dropped.
    recorder.record(operation());
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    expect(await recorder.flush(1_000)).toBe('flushed');
    expect(recorder.counters()).toMatchObject({
      enqueued: 2,
      appended: 2,
      dropped: { shutdown: 0 },
    });
  });

  it('drops invalid and oversized operations without throwing', () => {
    const recorder = createOperationRecorder({
      graphId: 'graph',
      store: {
        atomicFeed: { sourceAcceptance: true, nativeTransactions: true },
        appendOperations: async () => {},
        feed: {
          read: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
        operations: {
          list: async () => ({ entries: [], nextCursor: '', hasMore: false }),
        },
      },
      capture: { maxOperationBytes: 2_000 },
    });

    recorder.record(operation({ outcome: { status: 'succeeded' } }));
    recorder.record(
      operation({
        objects: Array.from({ length: 50 }, (_, index) => ({
          objectDefinitionId: 'business.customer',
          objectId: `cus_${index}`,
          role: 'returned',
          returned: [],
          forbidden: [],
          unavailable: [],
        })),
      }),
    );
    expect(recorder.counters().dropped).toMatchObject({
      invalid: 1,
      oversized: 1,
    });
  });
});

describe('memory operation retention', () => {
  it('rejects an operation larger than retention instead of evicting it', async () => {
    const activity = createMemoryStore({
      activity: { operationBytes: 1_000, rowBytes: 4_096 },
    }).activity!;
    const large = operation({
      objects: Array.from({ length: 20 }, (_, index) => ({
        objectDefinitionId: 'business.customer',
        objectId: `cus_${index}`,
        role: 'returned',
        returned: [],
        forbidden: [],
        unavailable: [],
      })),
    });

    await expect(activity.appendOperations('graph', [large])).rejects.toThrow(
      'Operation batch exceeds activity limits',
    );
    await activity.appendOperations('graph', [operation()]);
    expect((await activity.operations.list('graph', {})).entries).toHaveLength(
      1,
    );
  });
});

describe('uuidv7', () => {
  it('sorts by creation within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => uuidv7(1_000));

    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);
  });
});

it('isolates diagnostic providers by operation and ignores provider failures', async () => {
  const store = createMemoryStore();
  const recorder = createOperationRecorder({
    store: store.activity!,
    graphId: 'graph',
  });
  const capture = createCapture({
    graphId: 'graph',
    definitionRevision: 'revision',
    recorder,
  });
  const scopes = [1, 2, 3].map(() =>
    createOperationScope({ kind: 'principal', id: 'ana' }),
  );
  const answers = await Promise.all(
    scopes.map((scope, index) =>
      capture.operation(
        scope,
        async () => {
          const diagnostics = operationDiagnostics(scope)!;

          diagnostics.analytical = () => {
            if (index === 2) throw new Error('observer failed');

            return {
              stages: {
                execution: { count: 1, totalMs: index + 1, maxMs: index + 1 },
              },
            };
          };
          await Promise.resolve();

          return index;
        },
        () => ({
          kind: 'query',
          definitionId: 'customer',
          objects: [],
          outcome: { status: 'ok' },
          details: {},
        }),
      ),
    ),
  );

  expect(answers).toEqual([0, 1, 2]);
  await recorder.drain(1000);
  const rows = (await store.activity!.operations.list('graph')).entries;

  expect(rows).toHaveLength(3);

  for (const [index, scope] of scopes.entries()) {
    expect(operationDiagnostics(scope)).toBeUndefined();
    expect(
      rows.find((row) => row.id === scope.id)!.details.analytical?.stages
        .execution?.totalMs,
    ).toBe(index === 2 ? undefined : index + 1);
  }
});
