import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import pg from 'pg';

/** Small driver boundary for lifecycle failure tests; never exposed to consumers. */
export interface StatementClient {
  connect(): Promise<void>;
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<readonly (readonly (string | null)[])[]>;
  cancel(target: StatementClient): Promise<void>;
  end(): Promise<void>;
  destroy(): void;
}

export type ClientFactory = (
  purpose: 'statement' | 'control',
) => StatementClient;

export function createClientFactory(settings: {
  url: string;
  startupTimeoutMs: number;
  cancelTimeoutMs: number;
}): ClientFactory {
  const clients = new WeakMap<StatementClient, pg.Client>();

  return (purpose) => {
    let cancelSocket: Socket | undefined;
    const timeout =
      purpose === 'control'
        ? settings.cancelTimeoutMs
        : settings.startupTimeoutMs;
    const client = new pg.Client({
      connectionString: settings.url,
      connectionTimeoutMillis: timeout,
      application_name:
        purpose === 'control' ? 'relate-analytics-control' : 'relate-analytics',
    });

    // Query promises report errors; idle socket errors must not crash the host.
    client.on('error', () => {});

    const wrapper: StatementClient = {
      async connect() {
        if (purpose === 'control') return;

        await client.connect();
      },
      async cancel(target) {
        const primary = clients.get(target);

        if (!primary) throw new Error('Unknown cancellation target');

        // pg exposes BackendKeyData on the client. Never cancel by PID alone.
        const identity = primary as pg.Client & {
          processID: number;
          secretKey: number;
          host: string;
          port: number;
        };
        const stream = primary.connection.stream as Socket;
        const packet = Buffer.alloc(16);

        packet.writeInt32BE(16, 0);
        packet.writeInt32BE(80877102, 4);
        packet.writeInt32BE(identity.processID, 8);
        packet.writeInt32BE(identity.secretKey, 12);
        await new Promise<void>((resolve, reject) => {
          // Pin to the connected endpoint, including a pooler's virtual backend key.
          cancelSocket = identity.host.startsWith('/')
            ? createConnection(`${identity.host}/.s.PGSQL.${identity.port}`)
            : createConnection({
                host: stream.remoteAddress!,
                port: stream.remotePort!,
              });
          cancelSocket.once('connect', () => cancelSocket!.end(packet));
          cancelSocket.once('error', reject);
          cancelSocket.once('close', () => resolve());
        });
      },
      async query(sql, values) {
        const result = await client.query({
          text: sql,
          values: values ? [...values] : [],
          rowMode: 'array',
          // Per-query raw text avoids global parser changes and Date precision loss.
          types: { getTypeParser: () => (value: string) => value },
        });

        return result.rows;
      },
      end: async () => {
        if (purpose === 'control') {
          cancelSocket?.destroy();

          return;
        }

        await client.end();
      },
      destroy: () => {
        cancelSocket?.destroy();

        if (purpose === 'control') return;

        // An explicit error also rejects pg.connect() while end() marks the client as ending.
        client.connection.stream.destroy(
          new Error('PostgreSQL connection closed'),
        );
      },
    };

    clients.set(wrapper, client);

    return wrapper;
  };
}
