import { expect, it, vi } from 'vitest';
import { compile } from 'relate/compiler';
import {
  createDevClient,
  inspectorBaseUrl,
  takeFragmentToken,
} from '../src/connection/client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { DevEvent } from '../src/protocol.js';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { graph } = createInvoiceGraph();

const compiled = compile(graph);
const model = (generation: number) => ({
  generation,
  definitionRevision: compiled.definitionRevision,
  manifest: compiled.manifest,
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  emit(event: DevEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  fail() {
    this.onerror?.();
  }

  close() {
    this.closed = true;
  }
}

interface Server {
  snapshot: () => unknown;
  snapshotStatus?: number;
  sessionStatus?: number;
  requests: { url: string; method: string; body?: string }[];
}

function fakeFetch(server: Server): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    server.requests.push({
      url,
      method,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });

    if (url.endsWith('/dev/session'))
      return new Response(null, { status: server.sessionStatus ?? 204 });

    if (url.endsWith('/dev/snapshot')) {
      const status = server.snapshotStatus ?? 200;

      return new Response(
        status === 200 ? JSON.stringify(server.snapshot()) : null,
        { status },
      );
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(server: Server, token?: string) {
  FakeEventSource.instances = [];

  return createDevClient({
    baseUrl: new URL('http://127.0.0.1:4318/'),
    token,
    fetch: fakeFetch(server),
    createEventSource: (url) =>
      new FakeEventSource(url) as unknown as EventSource,
    retryDelaysMs: [1],
  });
}

const snapshot = (sequence: number, instanceId = 'i1'): DevEvent => ({
  protocolVersion: PROTOCOL_VERSION,
  instanceId,
  sequence,
  type: 'snapshot',
  model: model(1),
  failure: null,
});

it('exchanges the fragment token, loads a snapshot and streams in-order events', async () => {
  const server: Server = { snapshot: () => snapshot(3), requests: [] };
  const client = setup(server, 'abc');

  await client.start();
  expect(
    server.requests.map((r) => [r.method, new URL(r.url).pathname]),
  ).toEqual([
    ['POST', '/dev/session'],
    ['GET', '/dev/snapshot'],
  ]);
  expect(server.requests[0]!.body).toBe(JSON.stringify({ token: 'abc' }));
  expect(client.getState()).toMatchObject({
    connection: 'live',
    sequence: 3,
    model: { generation: 1 },
  });
  const stream = FakeEventSource.instances[0]!;

  expect(new URL(stream.url).pathname).toBe('/dev/events');
  stream.emit({
    protocolVersion: PROTOCOL_VERSION,
    instanceId: 'i1',
    sequence: 4,
    type: 'model',
    model: model(2),
    fromGeneration: 1,
    diff: {
      objects: { added: [], changed: [], removed: [] },
      relationships: { added: [], changed: [], removed: [] },
      otherChanged: true,
    },
    durationMs: 12,
  });
  expect(client.getState().model?.generation).toBe(2);
  client.stop();
  expect(stream.closed).toBe(true);
});

it('resynchronizes from a snapshot after a sequence gap and reconnects after stream errors', async () => {
  let sequence = 3;
  const server: Server = { snapshot: () => snapshot(sequence), requests: [] };
  const client = setup(server);

  await client.start();
  const first = FakeEventSource.instances[0]!;

  sequence = 9;
  first.emit({
    protocolVersion: PROTOCOL_VERSION,
    instanceId: 'i1',
    sequence: 8,
    type: 'diagnostics',
    attempt: 2,
    diagnostics: [],
  });
  await flush();
  expect(first.closed).toBe(true);
  expect(client.getState().sequence).toBe(9);
  expect(FakeEventSource.instances).toHaveLength(2);

  const second = FakeEventSource.instances[1]!;

  second.fail();
  expect(client.getState().connection).toBe('reconnecting');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(client.getState().connection).toBe('live');
  expect(FakeEventSource.instances).toHaveLength(3);
  client.stop();
});

it('keeps the graph as stale when the session is rejected or the protocol is unsupported', async () => {
  const server: Server = { snapshot: () => snapshot(1), requests: [] };
  const client = setup(server);

  await client.start();
  server.snapshotStatus = 401;
  FakeEventSource.instances[0]!.fail();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(client.getState()).toMatchObject({
    connection: 'stale',
    staleReason: 'session',
    model: { generation: 1 },
  });
  expect(FakeEventSource.instances).toHaveLength(1);
  client.stop();

  const upgraded: Server = {
    snapshot: () => ({ ...snapshot(1), protocolVersion: 2 }),
    requests: [],
  };
  const old = setup(upgraded);

  await old.start();
  expect(old.getState()).toMatchObject({
    connection: 'stale',
    staleReason: 'protocol',
    unsupportedProtocol: 2,
  });
  expect(FakeEventSource.instances).toHaveLength(0);
  old.stop();
});

it('shows the terminal-link instructions when there is no session at all', async () => {
  const server: Server = {
    snapshot: () => snapshot(1),
    snapshotStatus: 401,
    requests: [],
  };
  const client = setup(server);

  await client.start();
  expect(client.getState().connection).toBe('unauthorized');
  expect(FakeEventSource.instances).toHaveLength(0);

  const rejected = setup(
    { snapshot: () => snapshot(1), sessionStatus: 403, requests: [] },
    'bad',
  );

  await rejected.start();
  expect(rejected.getState().connection).toBe('unauthorized');
});

it('reads the fragment token once and derives the mount from the document path', () => {
  const replaced: string[] = [];
  const history = {
    replaceState: (_: unknown, __: string, url: string) => {
      replaced.push(url);
    },
  } as unknown as History;
  const location = {
    hash: '#token=abc_DEF-123',
    pathname: '/tools/inspector/',
    search: '',
    origin: 'http://127.0.0.1:4318',
  } as Location;

  expect(takeFragmentToken(location, history)).toBe('abc_DEF-123');
  expect(replaced).toEqual(['/tools/inspector/']);
  expect(
    takeFragmentToken({ ...location, hash: '#other' } as Location, history),
  ).toBeUndefined();
  expect(inspectorBaseUrl(location).toString()).toBe(
    'http://127.0.0.1:4318/tools/inspector/',
  );
  expect(
    inspectorBaseUrl({
      ...location,
      pathname: '/tools/inspector',
    } as Location).toString(),
  ).toBe('http://127.0.0.1:4318/tools/inspector/');
});

it.each(['shape', 'severity'])(
  'backs off invalid %s snapshots and recovers without losing the model',
  async (kind) => {
    vi.useFakeTimers();
    const server: Server = { snapshot: () => snapshot(1), requests: [] };
    const client = createDevClient({
      baseUrl: new URL('http://127.0.0.1:4318/'),
      fetch: fakeFetch(server),
      createEventSource: (url) =>
        new FakeEventSource(url) as unknown as EventSource,
      retryDelaysMs: [1000, 2000],
    });

    try {
      server.snapshot = () =>
        kind === 'shape'
          ? { ...snapshot(1), extra: 'unsupported' }
          : {
              ...snapshot(1),
              failure: {
                attempt: 1,
                diagnostics: [
                  {
                    kind: 'compile',
                    code: 'bad',
                    severity: 'warning',
                    message: 'bad',
                  },
                ],
              },
            };
      await expect(client.start()).resolves.toBeUndefined();
      expect(client.getState().connection).toBe('reconnecting');
      expect(server.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(server.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(server.requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(server.requests).toHaveLength(2);
      server.snapshot = () => snapshot(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(client.getState()).toMatchObject({
        connection: 'live',
        sequence: 3,
      });
      const stream = FakeEventSource.instances.at(-1)!;

      server.snapshot = () => ({
        ...snapshot(3),
        failure: {
          attempt: 2,
          diagnostics: [
            {
              kind: 'compile',
              code: 'bad',
              severity: 'warning',
              message: 'bad',
            },
          ],
        },
      });
      stream.onmessage?.({ data: JSON.stringify(server.snapshot()) });
      await vi.advanceTimersByTimeAsync(0);
      expect(stream.closed).toBe(true);
      expect(client.getState()).toMatchObject({
        connection: 'reconnecting',
        sequence: 3,
        model: { generation: 1 },
      });
      expect(server.requests).toHaveLength(4);
    } finally {
      client.stop();
      vi.useRealTimers();
    }
  },
);
