/**
 * One server-sent event stream: an initial payload and later ones, captured
 * atomically with the subscription so nothing falls between them, plus named
 * heartbeats the browser ignores. Shared by `/dev/events` and `/dev/activity`.
 */
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

export interface SseStreams {
  /** Register a stream's close function; returns its unregister. */
  add(close: () => void): () => void;
  /** Close every open stream, for shutdown. */
  closeAll(): void;
}

export function createSseStreams(): SseStreams {
  const streams = new Set<() => void>();

  return {
    add(close) {
      streams.add(close);

      return () => streams.delete(close);
    },
    closeAll() {
      for (const close of [...streams]) close();
    },
  };
}

export function streamJson<T>(
  c: Context,
  options: {
    readonly streams: SseStreams;
    readonly heartbeatMs: number;
    /** Register a listener; return the initial payload and an unsubscribe. */
    readonly subscribe: (send: (payload: T) => void) => {
      readonly initial: T;
      unsubscribe(): void;
    };
  },
): Response {
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
      unregister();
      void stream.close();
      resolveClosed();
    };
    // Unnamed events reach EventSource.onmessage; heartbeats are named and ignored.
    const subscription = options.subscribe((payload) => {
      void stream.writeSSE({ data: JSON.stringify(payload) }).catch(close);
    });
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ data: '', event: 'heartbeat' }).catch(close);
    }, options.heartbeatMs);
    const unregister = options.streams.add(close);

    stream.onAbort(close);
    await stream.writeSSE({ data: JSON.stringify(subscription.initial) });

    await untilClosed;
  });
}
