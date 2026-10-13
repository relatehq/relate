import { expect, it, vi } from 'vitest';
import {
  ACTIVITY_REQUEST_LIMIT,
  TOUCH_MS,
  applyActivity,
  createActivityClient,
  groupActivity,
  initialActivity,
  touchedDefinitions,
} from '../src/connection/activity.js';
import { activityMessageSchema } from '../src/protocol.js';
import type {
  CallEvent,
  ExecutionEvent,
  OperationEvent,
} from '../src/protocol.js';

const at = new Date(0).toISOString();
const call = (
  requestId: string,
  status: CallEvent['status'] = 'running',
): CallEvent => ({
  kind: 'call',
  requestId,
  runtimeId: 'runtime-1',
  source: 'external',
  principal: 'alice',
  tool: 'execute',
  at,
  status,
});
const execution = (requestId: string): ExecutionEvent => ({
  kind: 'execution',
  executionId: `execution-${requestId}`,
  requestId,
  runtimeId: 'runtime-1',
  principal: 'alice',
  at,
  code: 'return 1;',
  codeTruncated: false,
  status: 'running',
  logs: [],
  logsTruncated: false,
});
const operation = (
  requestId: string,
  opId: string,
  definitionId = 'notes.note',
): OperationEvent => ({
  kind: 'operation',
  opId,
  context: {
    requestId,
    runtimeId: 'runtime-1',
    definitionRevision: 'rev',
    principal: 'alice',
    transport: 'mcp',
    executionId: `execution-${requestId}`,
  },
  at,
  op: 'query',
  definitionId,
  request: { limit: 10 },
  status: 'running',
  recordIds: [],
});

it('replaces events in place, groups them by request newest first and touches only live operations', () => {
  const snapshot = applyActivity(
    initialActivity,
    {
      type: 'snapshot',
      events: [call('a'), operation('a', 'op-old', 'notes.old')],
    },
    1_000,
  );
  let state = snapshot;

  for (const event of [
    call('b'),
    execution('b'),
    operation('b', 'op-1'),
    { ...call('b'), status: 'succeeded' as const, ms: 12 },
  ])
    state = applyActivity(state, { type: 'event', event }, 1_000);

  expect(snapshot.connection).toBe('live');
  expect(touchedDefinitions(snapshot, 1_000)).toEqual(new Set());
  expect(state.events.map((event) => [event.kind, event.status])).toEqual([
    ['call', 'running'],
    ['operation', 'running'],
    ['call', 'succeeded'],
    ['execution', 'running'],
    ['operation', 'running'],
  ]);
  expect(groupActivity(state.events)).toMatchObject([
    {
      requestId: 'b',
      call: { status: 'succeeded', ms: 12 },
      execution: { executionId: 'execution-b' },
      operations: [{ opId: 'op-1' }],
    },
    { requestId: 'a', operations: [{ opId: 'op-old' }] },
  ]);
  expect(touchedDefinitions(state, 1_000 + TOUCH_MS - 1)).toEqual(
    new Set(['notes.note']),
  );
  expect(touchedDefinitions(state, 1_000 + TOUCH_MS)).toEqual(new Set());
});

it('keeps the newest requests when a long-lived tab passes the limit', () => {
  let state = initialActivity;

  for (let index = 0; index <= ACTIVITY_REQUEST_LIMIT; index += 1)
    state = applyActivity(state, { type: 'event', event: call(`r${index}`) });

  expect(state.events).toHaveLength(ACTIVITY_REQUEST_LIMIT);
  expect(state.events[0]).toMatchObject({ requestId: 'r1' });
});

it('validates activity messages before applying them', () => {
  expect(
    activityMessageSchema.safeParse({ type: 'event', event: call('a') })
      .success,
  ).toBe(true);
  expect(
    activityMessageSchema.safeParse({
      type: 'event',
      event: { ...operation('a', 'op'), context: { requestId: 'a' } },
    }).success,
  ).toBe(false);
});

it('opens /dev/activity under the mount and reopens a refused stream from a fresh snapshot', () => {
  vi.useFakeTimers();

  try {
    const sources: {
      url: string;
      readyState: number;
      onmessage: ((message: { data: string }) => void) | null;
      onerror: (() => void) | null;
      close: () => void;
    }[] = [];
    const client = createActivityClient({
      baseUrl: new URL('http://127.0.0.1:4318/nested/'),
      retryMs: 100,
      createEventSource: (url) => {
        const source = {
          url,
          readyState: 1,
          onmessage: null,
          onerror: null,
          close: vi.fn(),
        };

        sources.push(source);

        return source as unknown as EventSource;
      },
    });

    client.start();
    sources[0]!.onmessage!({
      data: JSON.stringify({ type: 'snapshot', events: [call('a')] }),
    });
    expect(sources[0]!.url).toBe('http://127.0.0.1:4318/nested/dev/activity');
    expect(client.getState().events).toHaveLength(1);

    sources[0]!.readyState = 2;
    sources[0]!.onerror!();
    expect(client.getState().connection).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    sources[1]!.onmessage!({
      data: JSON.stringify({ type: 'snapshot', events: [] }),
    });

    expect(sources).toHaveLength(2);
    expect(client.getState()).toMatchObject({ connection: 'live', events: [] });
    client.stop();
  } finally {
    vi.useRealTimers();
  }
});
