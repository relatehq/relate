/**
 * The stable HTTP surface of `relate dev`: the inspector shell and assets plus
 * `/dev/session`, `/dev/snapshot`, `/dev/events`, `/dev/activity`,
 * `/dev/instance` and `/mcp`. Every response here is `no-store`; the inspector
 * package owns asset caching.
 */
import { Hono } from 'hono';
import { PROTOCOL_VERSION, createInspectorApp } from '@relate/inspector/server';
import type { DevEvent } from '@relate/inspector/protocol';
import type { InspectorApp } from '@relate/inspector/server';
import { activityRoute, createActivityLog } from './activity/index.js';
import type { ActivityLog } from './activity/index.js';
import type { Sessions } from './session.js';
import { createSseStreams, streamJson } from './sse.js';
import type { Supervisor } from './supervisor.js';

export interface DevServerOptions {
  readonly supervisor: Supervisor;
  readonly sessions: Sessions;
  readonly ownerId: string;
  readonly inspector?: InspectorApp;
  /** What MCP clients did; an empty log when omitted. */
  readonly activity?: ActivityLog;
  /** The `/mcp` handler; it does its own bearer authentication. */
  readonly mcp?: (request: Request) => Promise<Response>;
  /** Keep-alive comment interval for SSE connections. */
  readonly heartbeatMs?: number;
}

export interface DevServer {
  readonly app: Hono;
  readonly inspector: InspectorApp;
  /** Close every open event stream, for shutdown. */
  closeStreams(): void;
}

const noStore = { 'Cache-Control': 'no-store' };

export function createDevServer(options: DevServerOptions): DevServer {
  const inspector = options.inspector ?? createInspectorApp();
  const app = new Hono();
  const streams = createSseStreams();
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  app.use('*', options.sessions.guard);

  // Public identity for duplicate-invocation verification; never token material.
  app.get('/dev/instance', (c) =>
    c.json(
      {
        instanceId: options.supervisor.state.instanceId,
        protocolVersion: PROTOCOL_VERSION,
        ownerId: options.ownerId,
      },
      200,
      noStore,
    ),
  );

  app.post('/dev/session', (c) => options.sessions.exchange(c));

  app.use('/dev/snapshot', options.sessions.requireSession);
  app.use('/dev/events', options.sessions.requireSession);
  app.use('/dev/activity', options.sessions.requireSession);

  app.get('/dev/snapshot', (c) =>
    c.json(options.supervisor.snapshot(), 200, noStore),
  );

  app.get('/dev/events', (c) =>
    streamJson<DevEvent>(c, {
      streams,
      heartbeatMs,
      subscribe(send) {
        const subscription = options.supervisor.subscribe(send);

        return {
          initial: subscription.snapshot,
          unsubscribe: subscription.unsubscribe,
        };
      },
    }),
  );

  app.get(
    '/dev/activity',
    activityRoute({
      log: options.activity ?? createActivityLog(),
      streams,
      heartbeatMs,
    }),
  );

  // Bearer-authenticated by the handler; the session cookie does not apply.
  if (options.mcp) {
    const mcp = options.mcp;

    app.all('/mcp', (c) => mcp(c.req.raw));
  }

  app.all('/dev/*', (c) => c.json({ error: 'Not found' }, 404, noStore));
  app.route('/', inspector.app);

  return {
    app,
    inspector,
    closeStreams() {
      streams.closeAll();
    },
  };
}
