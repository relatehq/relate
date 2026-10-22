import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { postgres } from '@relate/connector-postgres';
import type { AnalyticalExecutionTiming } from 'relate/connectors';
import { aggregate, query } from './fixtures.js';

it.each(['timeout', 'abort', 'retire'] as const)(
  'disconnects a real socket that never completes PostgreSQL startup: %s',
  async (mode) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', () => {});
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();

    if (!address || typeof address === 'string')
      throw new Error('Missing test port');

    const connection = postgres({
      connectionId: 'stalled',
      url: `postgres://test@127.0.0.1:${address.port}/test`,
      analyticalStartupTimeoutMs: mode === 'timeout' ? 30 : 1000,
    });

    try {
      const resource = connection
        .table('events')
        .bindDataset({ columns: { customerId: 'customer_id' } });
      const timings: AnalyticalExecutionTiming[] = [];

      const controller = new AbortController();
      const connected = new Promise<void>((resolve) =>
        server.once('connection', () => resolve()),
      );
      const outcome = connection.analytics
        .execute(
          connection.analytics.plan(
            query(resource, [aggregate('count', '*', 'int64')], ['acme']),
          ),
          {
            signal: controller.signal,
            timeoutMs: 1000,
            onTiming: (timing) => timings.push(timing),
          },
        )
        .catch((error) => error);

      if (mode !== 'timeout') {
        await connected;

        if (mode === 'abort') controller.abort(new Error('startup aborted'));
        else await connection.close();
      }

      expect(await outcome).toBeInstanceOf(Error);
      await vi.waitFor(() => expect(sockets.size).toBe(0));
      expect(timings.map((timing) => timing.stage)).toEqual([
        'connectionStartup',
      ]);
    } finally {
      await connection.close();

      for (const socket of sockets) socket.destroy();

      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
