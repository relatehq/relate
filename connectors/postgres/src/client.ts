import pg from 'pg';

/** Small driver boundary for lifecycle failure tests; never exposed to consumers. */
export interface StatementClient {
  connect(): Promise<void>;
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<readonly (readonly (string | null)[])[]>;
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
  return (purpose) => {
    const timeout =
      purpose === 'control'
        ? settings.cancelTimeoutMs
        : settings.startupTimeoutMs;
    const client = new pg.Client({
      connectionString: settings.url,
      connectionTimeoutMillis: timeout,
      // Setup and control queries also have a server bound. Execution tightens it locally.
      statement_timeout: timeout,
      application_name:
        purpose === 'control' ? 'relate-analytics-control' : 'relate-analytics',
    });

    // Query promises report errors; idle socket errors must not crash the host.
    client.on('error', () => {});

    return {
      async connect() {
        await client.connect();
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
      end: () => client.end(),
      destroy: () => {
        // An explicit error also rejects pg.connect() while end() marks the client as ending.
        client.connection.stream.destroy(
          new Error('PostgreSQL connection closed'),
        );
      },
    };
  };
}
