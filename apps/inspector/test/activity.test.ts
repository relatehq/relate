import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ACTIVITY_REQUEST_LIMIT,
  ActivityBuffer,
  PUBLISH_MS,
  TOUCH_MS,
  createActivityClient,
  followSession,
  groupActivity,
  parseActivityMessage,
  touchedDefinitions,
} from '../src/connection/activity.js';
import type { ActivityState } from '../src/connection/activity.js';
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

interface FakeSource {
  url: string;
  readyState: number;
  onmessage: ((message: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close: () => void;
}

function fakeSources() {
  const sources: FakeSource[] = [];

  return {
    sources,
    createEventSource: (url: string) => {
      const source: FakeSource = {
        url,
        readyState: 1,
        onmessage: null,
        onerror: null,
        close: vi.fn(),
      };

      sources.push(source);

      return source as unknown as EventSource;
    },
  };
}

const send = (source: FakeSource, payload: unknown) =>
  source.onmessage!({ data: JSON.stringify(payload) });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('replaces events in place, groups them by request newest first and touches only live operations', () => {
  const buffer = new ActivityBuffer();

  buffer.replace([call('a'), operation('a', 'op-old', 'notes.old')]);
  buffer.upsert(call('b'), 1_000);
  buffer.upsert(execution('b'), 1_000);
  buffer.upsert(operation('b', 'op-1'), 1_000);
  buffer.upsert({ ...call('b'), status: 'succeeded', ms: 12 }, 1_000);

  const events = buffer.list();
  const state: ActivityState = {
    connection: 'live',
    events,
    touched: buffer.touched(1_000),
  };

  expect(events.map((event) => [event.kind, event.status])).toEqual([
    ['call', 'running'],
    ['operation', 'running'],
    ['call', 'succeeded'],
    ['execution', 'running'],
    ['operation', 'running'],
  ]);
  expect(groupActivity(events)).toMatchObject([
    {
      requestId: 'b',
      call: { status: 'succeeded', ms: 12 },
      execution: { executionId: 'execution-b' },
      operations: [{ opId: 'op-1' }],
    },
    { requestId: 'a', operations: [{ opId: 'op-old' }] },
  ]);
  // The snapshot's notes.old never glows; the live notes.note does, briefly.
  expect(touchedDefinitions(state, 1_000 + TOUCH_MS - 1)).toEqual(
    new Set(['notes.note']),
  );
  expect(touchedDefinitions(state, 1_000 + TOUCH_MS)).toEqual(new Set());
  expect(buffer.touched(1_000 + TOUCH_MS).size).toBe(0);
});

it('keeps the newest requests when a long-lived tab passes the limit', () => {
  const buffer = new ActivityBuffer();

  for (let index = 0; index <= ACTIVITY_REQUEST_LIMIT; index += 1)
    buffer.upsert(call(`r${index}`));

  expect(buffer.list()).toHaveLength(ACTIVITY_REQUEST_LIMIT);
  expect(buffer.list()[0]).toMatchObject({ requestId: 'r1' });
});

it('skips an unreadable event instead of discarding the snapshot around it', () => {
  // A NaN limit once serialized as null; such an event must not poison the feed.
  const broken = { ...operation('a', 'op-1'), request: { limit: null } };

  expect(
    parseActivityMessage({
      type: 'snapshot',
      events: [call('a'), broken, call('b')],
    }),
  ).toEqual({ type: 'snapshot', events: [call('a'), call('b')] });
  expect(parseActivityMessage({ type: 'event', event: broken })).toEqual({
    type: 'event',
    event: null,
  });
  expect(parseActivityMessage({ type: 'other' })).toBeNull();
});

it('publishes a burst of events once, under the mount', () => {
  const { sources, createEventSource } = fakeSources();
  const client = createActivityClient({
    baseUrl: new URL('http://127.0.0.1:4318/nested/'),
    createEventSource,
    now: () => 0,
  });
  const listener = vi.fn();

  client.subscribe(listener);
  client.start();
  send(sources[0]!, { type: 'snapshot', events: [call('a')] });

  for (let index = 0; index < 100; index += 1)
    send(sources[0]!, {
      type: 'event',
      event: operation('a', `op-${index}`),
    });

  expect(sources[0]!.url).toBe('http://127.0.0.1:4318/nested/dev/activity');
  expect(client.getState().events).toHaveLength(0);
  listener.mockClear();
  vi.advanceTimersByTime(PUBLISH_MS);

  expect(listener).toHaveBeenCalledTimes(1);
  expect(client.getState()).toMatchObject({ connection: 'live' });
  expect(client.getState().events).toHaveLength(101);
  client.stop();
});

it('reopens a refused stream with backoff and stops for good when told to', () => {
  const { sources, createEventSource } = fakeSources();
  const client = createActivityClient({
    baseUrl: new URL('http://127.0.0.1:4318/'),
    createEventSource,
    retryDelaysMs: [100, 400],
  });

  client.start();
  sources[0]!.readyState = 2;
  sources[0]!.onerror!();
  expect(client.getState().connection).toBe('reconnecting');
  vi.advanceTimersByTime(100);
  expect(sources).toHaveLength(2);
  sources[1]!.readyState = 2;
  sources[1]!.onerror!();
  vi.advanceTimersByTime(399);
  expect(sources).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(sources).toHaveLength(3);

  client.stop();
  vi.advanceTimersByTime(10_000);

  expect(sources).toHaveLength(3);
  expect(client.getState().connection).toBe('stopped');
});

it('runs the stream only while the inspector session is live', () => {
  let connection = 'connecting';
  const listeners = new Set<() => void>();
  const dev = {
    getState: () => ({ connection }) as never,
    subscribe: (listener: () => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
  const activity = { start: vi.fn(), stop: vi.fn() };
  const change = (next: string) => {
    connection = next;

    for (const listener of listeners) listener();
  };

  followSession(dev, activity);
  expect(activity.start).not.toHaveBeenCalled();
  change('live');
  expect(activity.start).toHaveBeenCalledTimes(1);
  // A temporary drop keeps the stream's own retries; a lost session stops it.
  change('reconnecting');
  expect(activity.stop).not.toHaveBeenCalled();
  change('stale');
  expect(activity.stop).toHaveBeenCalledTimes(1);
  change('unauthorized');
  expect(activity.stop).toHaveBeenCalledTimes(2);
});
