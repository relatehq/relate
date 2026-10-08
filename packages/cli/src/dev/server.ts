/**
 * The stable HTTP surface of `relate dev`: the inspector shell and assets plus
 * `/dev/session`, `/dev/snapshot`, `/dev/events` and `/dev/instance`. Every
 * response here is `no-store`; the inspector package owns asset caching.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { PROTOCOL_VERSION, createInspectorApp } from '@relate/inspector/server';
import type { InspectorApp } from '@relate/inspector/server';
import type { Sessions } from './session.js';
import type { Supervisor } from './supervisor.js';

export interface DevServerOptions {
  readonly supervisor: Supervisor;
  readonly sessions: Sessions;
  readonly ownerId: string;
  readonly inspector?: InspectorApp;
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
  const streams = new Set<() => void>();

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

  app.get('/dev/snapshot', (c) =>
    c.json(options.supervisor.snapshot(), 200, noStore),
  );

  app.get('/dev/events', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      let closed = false;
      let resolveClosed!: () => void;
      const untilClosed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const close = () => {
        if (closed) return;

        closed = true;
        subscription.unsubscribe();
        clearInterval(heartbeat);
        streams.delete(close);
        void stream.close();
        resolveClosed();
      };
      // Snapshot and registration happen synchronously: no update is lost between them.
      // Unnamed events reach EventSource.onmessage; heartbeats are named and ignored.
      const subscription = options.supervisor.subscribe((event) => {
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(close);
      });
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: '', event: 'heartbeat' }).catch(close);
      }, options.heartbeatMs ?? 15_000);

      streams.add(close);
      stream.onAbort(close);
      await stream.writeSSE({ data: JSON.stringify(subscription.snapshot) });

      await untilClosed;
    });
  });

  app.all('/dev/*', (c) => c.json({ error: 'Not found' }, 404, noStore));
  app.route('/', inspector.app);

  return {
    app,
    inspector,
    closeStreams() {
      for (const close of [...streams]) close();
    },
  };
}
