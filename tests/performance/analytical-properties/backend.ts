import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { sqlite } from '@relate/connector-sqlite';
import { postgres } from '@relate/connector-postgres';
import { createPostgresStore } from '@relate/postgres';
import { createMemoryStore } from '@relate/runtime';
import type { ObservationStore } from 'relate/storage';
import type { AnalyticalResource } from 'relate/connectors';
import type { Event } from './model.js';
import { openDuckBackend } from './duckdb.js';

export interface Backend {
  resource: AnalyticalResource;
  version: string;
  file?: string;
  close(): Promise<void>;
}

function databaseUrl() {
  const value = process.env.RELATE_TEST_DATABASE_URL;

  if (!value)
    throw new Error(
      'Postgres benchmarks require RELATE_TEST_DATABASE_URL for a dedicated disposable database',
    );

  return value;
}

/** Owned resources only; no global schema reset and no credentials in reports. */
export async function openBackend(
  kind: 'sqlite' | 'postgres' | 'duckdb',
  rows: Iterable<Event>,
): Promise<Backend> {
  if (kind === 'duckdb') return openDuckBackend(rows);

  if (kind === 'sqlite') {
    const directory = await mkdtemp(join(tmpdir(), 'relate-analytical-bench-'));
    const path = join(directory, 'events.sqlite');

    try {
      const db = new DatabaseSync(path);
      let version: string;

      try {
        db.exec(
          'CREATE TABLE events(customer TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL); BEGIN',
        );
        const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?)');

        for (const row of rows) insert.run(row.customer, row.type, row.at);

        db.exec(
          'COMMIT; CREATE INDEX events_customer_type_at ON events(customer,type,at); ANALYZE',
        );
        version = String(
          db.prepare('SELECT sqlite_version() AS version').get()!.version,
        );
      } finally {
        db.close();
      }

      const connection = sqlite({ connectionId: 'benchmark-analytics', path });

      return {
        resource: connection.table('events'),
        version,
        async close() {
          try {
            await connection.close();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  const client = new pg.Client({
    connectionString: databaseUrl(),
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
  });
  const schema = `benchmark_${randomUUID().replaceAll('-', '')}`;
  let created = false;

  try {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(
      `CREATE TABLE "${schema}".events(customer TEXT NOT NULL, type TEXT NOT NULL, at TIMESTAMPTZ(3) NOT NULL)`,
    );
    await client.query('BEGIN');

    try {
      let batch: Event[] = [];
      const insert = async () => {
        if (!batch.length) return;

        const placeholders = batch
          .map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`)
          .join(',');

        await client.query(
          `INSERT INTO "${schema}".events VALUES ${placeholders}`,
          batch.flatMap((row) => [row.customer, row.type, row.at]),
        );
        batch = [];
      };

      for (const row of rows) {
        batch.push(row);

        if (batch.length === 4000) await insert();
      }

      await insert();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    await client.query(
      `CREATE INDEX ON "${schema}".events(customer,type,at); ANALYZE "${schema}".events`,
    );
    const version = String(
      (await client.query('SHOW server_version')).rows[0].server_version,
    );
    const connection = postgres({
      connectionId: 'benchmark-analytics',
      url: databaseUrl(),
    });

    return {
      resource: connection.table('events', { schema }),
      version,
      async close() {
        try {
          await connection.close();
        } finally {
          try {
            await client.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await client.end();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await client.end();
    }

    throw error;
  }
}

export async function openStore(
  kind: 'memory' | 'postgres',
  graphId: string,
): Promise<{ store: ObservationStore; close(): Promise<void> }> {
  if (kind === 'memory')
    return { store: createMemoryStore(), close: async () => {} };

  const store = createPostgresStore({ connectionString: databaseUrl() });

  try {
    await store.migrate();
  } catch (error) {
    await store.close();
    throw error;
  }

  return {
    store,
    async close() {
      await store.close();
      const client = new pg.Client({
        connectionString: databaseUrl(),
        connectionTimeoutMillis: 5000,
        statement_timeout: 60000,
      });

      try {
        await client.connect();
        await client.query('BEGIN');

        // Delete only this run's graph. Other tests/workloads in the database survive.
        for (const table of [
          'operation_objects',
          'operations',
          'feed_entries',
          'feed_streams',
          'object_versions',
          'objects',
          'invocations',
          'native_objects',
          'graphs',
        ])
          await client.query(
            `DELETE FROM relate.${table} WHERE graph_id = $1`,
            [graphId],
          );

        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    },
  };
}
