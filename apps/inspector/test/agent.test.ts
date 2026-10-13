import { expect, it, vi } from 'vitest';
import {
  applyAgentEvent,
  createAgentClient,
  initialAgent,
  parseAgentEvent,
} from '../src/connection/agent.js';
import type { AgentEvent, AgentSnapshot } from '../src/protocol.js';

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

const snapshot = (
  conversations: AgentSnapshot['conversations'] = [],
): AgentSnapshot => ({
  type: 'snapshot',
  availability: { available: true, model: 'claude-opus-5-5' },
  conversations,
});

it('folds turn, message and text events into one conversation per principal', () => {
  const events: AgentEvent[] = [
    snapshot(),
    {
      type: 'turn',
      principal: 'alice',
      turn: { turnId: 't1', principal: 'alice', status: 'running' },
    },
    {
      type: 'message',
      principal: 'alice',
      message: { kind: 'assistant', id: 'm1', text: 'Hel' },
    },
    { type: 'text', principal: 'alice', messageId: 'm1', delta: 'lo' },
    {
      type: 'message',
      principal: 'bob',
      message: { kind: 'user', id: 'u1', at: 'now', text: 'Hi' },
    },
    { type: 'turn', principal: 'alice', turn: null },
  ];
  const state = events.reduce(applyAgentEvent, initialAgent);

  expect(state.conversations.get('alice')).toEqual({
    principal: 'alice',
    turn: null,
    messages: [{ kind: 'assistant', id: 'm1', text: 'Hello' }],
  });
  expect(state.conversations.get('bob')?.messages).toEqual([
    { kind: 'user', id: 'u1', at: 'now', text: 'Hi' },
  ]);
});

it('rejects payloads that do not match the protocol', () => {
  expect(parseAgentEvent({ type: 'text', principal: 'alice' })).toBeNull();
  expect(
    parseAgentEvent({
      ...snapshot(),
      availability: { available: true, model: 'x', apiKey: 'sk-ant' },
    }),
  ).toBeNull();
  expect(parseAgentEvent(snapshot())).toEqual(snapshot());
});

it('streams /dev/agent/events relative to the mount and skips invalid payloads', () => {
  const { sources, createEventSource } = fakeSources();
  const client = createAgentClient({
    baseUrl: new URL('http://127.0.0.1:4318/nested/'),
    createEventSource,
  });

  client.start();
  send(sources[0]!, snapshot());
  send(sources[0]!, { type: 'message', principal: 'alice', message: {} });

  expect(sources[0]!.url).toBe('http://127.0.0.1:4318/nested/dev/agent/events');
  expect(client.getState()).toMatchObject({
    connection: 'live',
    availability: { available: true },
    conversations: new Map(),
  });
});

it('forgets the old server’s availability when the session ends', () => {
  const { sources, createEventSource } = fakeSources();
  const client = createAgentClient({
    baseUrl: new URL('http://127.0.0.1:4318/'),
    createEventSource,
  });

  client.start();
  send(sources[0]!, {
    ...snapshot(),
    availability: { available: false, reason: 'missing-key' },
  });
  client.stop();

  expect(client.getState()).toMatchObject({
    connection: 'stopped',
    availability: null,
  });
});

it('posts turns and cancellations and validates the replies', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ turnId: 't1', principal: 'alice' }, { status: 202 }),
    )
    .mockResolvedValueOnce(
      Response.json({ error: 'A turn is already running' }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json({ turnId: 't1' }, { status: 202 }));
  const client = createAgentClient({
    baseUrl: new URL('http://127.0.0.1:4318/'),
    fetch,
    createEventSource: fakeSources().createEventSource,
  });

  expect(await client.send('alice', 'Hello')).toEqual({
    ok: true,
    turn: { turnId: 't1', principal: 'alice' },
  });
  expect(await client.send('alice', 'Again')).toEqual({
    ok: false,
    error: 'A turn is already running',
  });
  expect(await client.cancel('t1')).toEqual({
    ok: false,
    error: 'relate dev sent an unexpected reply',
  });
  expect(fetch.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
    [
      'http://127.0.0.1:4318/dev/agent/turns',
      JSON.stringify({ principal: 'alice', text: 'Hello' }),
    ],
    [
      'http://127.0.0.1:4318/dev/agent/turns',
      JSON.stringify({ principal: 'alice', text: 'Again' }),
    ],
    ['http://127.0.0.1:4318/dev/agent/turns/t1/cancel', '{}'],
  ]);
});
