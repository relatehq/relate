import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import {
  ListenError,
  Supervisor,
  bindLoopback,
  createDevServer,
  createSessions,
} from '@relate/cli';
import { createInspectorApp } from '@relate/inspector/server';
import { parseDevEvent } from '@relate/inspector/protocol';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { graph } = createInvoiceGraph();

const origin = 'http://127.0.0.1:4318';
const model = compile(graph);

function setup(allowedOrigins: string[] = [origin]) {
  const supervisor = new Supervisor('instance-1');
  const sessions = createSessions({ instanceId: 'instance-1', allowedOrigins });
  const server = createDevServer({
    supervisor,
    sessions,
    ownerId: 'owner-1',
    inspector: createInspectorApp({ assetsDirectory: '/nonexistent' }),
    heartbeatMs: 20,
  });
  const request = (
    path: string,
    init: RequestInit = {},
    host = '127.0.0.1:4318',
  ) =>
    server.app.request(`http://${host}${path}`, {
      ...init,
      headers: { host, ...(init.headers as Record<string, string>) },
    });

  return { supervisor, sessions, server, request };
}

async function session(
  request: ReturnType<typeof setup>['request'],
  token: string,
) {
  const response = await request('/dev/session', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const cookie = response.headers.get('set-cookie') ?? '';

  return { response, cookie: cookie.split(';')[0]! };
}

it('requires a session for metadata, exchanges the token for an HttpOnly cookie and validates Host and Origin', async () => {
  const { sessions, request } = setup();

  expect((await request('/dev/snapshot')).status).toBe(401);
  expect((await request('/dev/events')).status).toBe(401);
  expect((await request('/dev/snapshot', {}, 'evil.example')).status).toBe(403);
  expect(
    (
      await request('/dev/snapshot', {
        headers: { origin: 'http://attacker.example' },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request('/dev/snapshot', {
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
      })
    ).status,
  ).toBe(403);
  // Top-level navigations from elsewhere still reach the shell route table.
  expect(
    (
      await request('/dev/instance', {
        headers: {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
        },
      })
    ).status,
  ).toBe(200);

  // Public identity never carries token material.
  const identity = await (await request('/dev/instance')).json();

  expect(identity).toEqual({
    instanceId: 'instance-1',
    protocolVersion: 1,
    ownerId: 'owner-1',
  });
  expect(JSON.stringify(identity)).not.toContain(sessions.token);

  const withoutOrigin = await request('/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: sessions.token }),
  });

  expect(withoutOrigin.status).toBe(403);
  expect((await session(request, 'wrong-token')).response.status).toBe(403);

  const { response, cookie } = await session(request, sessions.token);

  expect(response.status).toBe(204);
  expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
  expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
  expect(response.headers.get('set-cookie')).not.toMatch(/Secure/);
  expect(cookie.startsWith(`${sessions.cookieName}=`)).toBe(true);
  expect(sessions.cookieName).toMatch(/^relate_dev_instance-1/);

  const snapshot = await request('/dev/snapshot', { headers: { cookie } });

  expect(snapshot.status).toBe(200);
  expect(snapshot.headers.get('cache-control')).toBe('no-store');
  expect(parseDevEvent(await snapshot.json())).toMatchObject({
    type: 'snapshot',
    instanceId: 'instance-1',
    sequence: 0,
    model: null,
    failure: null,
  });

  // The token is reusable for another tab until the instance exits.
  expect((await session(request, sessions.token)).response.status).toBe(204);
  sessions.clear();
  expect((await request('/dev/snapshot', { headers: { cookie } })).status).toBe(
    401,
  );
});

it('streams a snapshot first, then events in order, and resynchronizes from /dev/snapshot', async () => {
  const { supervisor, sessions, request, server } = setup();
  const { cookie } = await session(request, sessions.token);
  const response = await request('/dev/events', { headers: { cookie } });

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async () => {
    for (;;) {
      const index = buffer.indexOf('\n\n');

      if (index !== -1) {
        const chunk = buffer.slice(0, index);

        buffer = buffer.slice(index + 2);

        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');

        if (chunk.includes('event: heartbeat')) continue;

        return parseDevEvent(JSON.parse(data));
      }

      const { value, done } = await reader.read();

      if (done) throw new Error('stream ended');

      buffer += decoder.decode(value, { stream: true });
    }
  };

  expect(await next()).toMatchObject({ type: 'snapshot', sequence: 0 });
  supervisor.acceptFailure(1, [
    { kind: 'worker', code: 'worker.crash', severity: 'error', message: 'x' },
  ]);
  expect(await next()).toMatchObject({
    type: 'diagnostics',
    sequence: 1,
    attempt: 1,
  });
  supervisor.acceptModel(model, 42);
  expect(await next()).toMatchObject({
    type: 'model',
    sequence: 2,
    model: { generation: 1 },
    fromGeneration: null,
    durationMs: 42,
  });

  const resync = parseDevEvent(
    await (await request('/dev/snapshot', { headers: { cookie } })).json(),
  );

  expect(resync).toMatchObject({
    type: 'snapshot',
    sequence: 2,
    model: { generation: 1 },
    failure: null,
  });
  server.closeStreams();
  await reader.cancel();
});

let bound: Awaited<ReturnType<typeof bindLoopback>> | null = null;

afterEach(() => {
  bound?.server.close();
  bound = null;
});

it('binds the first free port in the default range and fails clearly on an occupied explicit port', async () => {
  const occupied = createServer();

  await new Promise<void>((resolve) =>
    occupied.listen(0, '127.0.0.1', resolve),
  );
  const port = (occupied.address() as { port: number }).port;

  try {
    await expect(bindLoopback(createServer, port)).rejects.toThrow(ListenError);
    await expect(bindLoopback(createServer, port)).rejects.toThrow(
      `Port ${port} is in use`,
    );
    bound = await bindLoopback(createServer, undefined, {
      from: port,
      to: port + 2,
    });
    expect(bound.port).toBe(port + 1);
    expect(bound.url).toBe(`http://127.0.0.1:${port + 1}`);
    expect(bound.notice).toBe(`Port ${port} is in use; using ${port + 1}`);
    await expect(
      bindLoopback(createServer, undefined, { from: port, to: port + 1 }),
    ).rejects.toThrow(/all in use/);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
