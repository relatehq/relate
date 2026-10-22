import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBValue } from '@duckdb/node-api';
import { duckdb } from '@relate/connector-duckdb';
import type { Backend } from './backend.js';
import type { Customer, Event } from './model.js';
import { since, until } from './model.js';
import type { Database } from './overhead/database.js';
import { concurrentMap } from './overhead/capture.js';

const readOptions = {
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
  autoload_known_extensions: 'false',
  autoinstall_known_extensions: 'false',
  threads: '1',
};

export async function openDuckBackend(rows: Iterable<Event>): Promise<Backend> {
  const directory = await mkdtemp(join(tmpdir(), 'relate-analytical-duck-'));
  const path = join(directory, 'events.duckdb');

  try {
    const instance = await DuckDBInstance.create(path, { threads: '1' });
    let writer: DuckDBConnection | undefined;
    let version: string;

    try {
      writer = await instance.connect();
      await writer.run(
        'CREATE TABLE seed(customer VARCHAR NOT NULL, type VARCHAR NOT NULL, "at" VARCHAR NOT NULL)',
      );
      const appender = await writer.createAppender('seed');

      try {
        for (const row of rows) {
          appender.appendVarchar(row.customer);
          appender.appendVarchar(row.type);
          appender.appendVarchar(row.at);
          appender.endRow();
        }
      } finally {
        appender.closeSync();
      }

      await writer.run(
        'CREATE TABLE events(customer VARCHAR NOT NULL, type VARCHAR NOT NULL, "at" TIMESTAMP_MS NOT NULL); INSERT INTO events SELECT customer, type, CAST("at" AS TIMESTAMP_MS) FROM seed; DROP TABLE seed; CREATE INDEX events_customer_type_at ON events(customer,type,"at"); ANALYZE',
      );
      version = String(
        (await writer.runAndReadAll('SELECT version()')).getRows()[0]![0],
      );
    } finally {
      writer?.closeSync();
      instance.closeSync();
    }

    const connection = duckdb({ connectionId: 'benchmark-analytics', path });

    return {
      resource: connection.table('events'),
      version,
      file: path,
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

export async function duckDatabase(
  path: string,
  records: Customer[],
  ids: Map<string, string>,
): Promise<Database> {
  const directory = await mkdtemp(join(tmpdir(), 'relate-colocated-duck-'));
  const snapshot = join(directory, 'colocated.duckdb');
  const instances: DuckDBInstance[] = [];
  const connections: DuckDBConnection[] = [];
  const close = async () => {
    for (const c of connections) c.closeSync();

    for (const db of instances) db.closeSync();

    await rm(directory, { recursive: true, force: true });
  };

  try {
    // Original is immutable and checkpointed. A copy permits seeding customers while
    // the connector's read-only workers retain locks on the original events file.
    await copyFile(path, snapshot);
    const writerDb = await DuckDBInstance.create(snapshot, { threads: '1' });
    let writer: DuckDBConnection | undefined;
    const aggregate = `SELECT c.id,c.name,c.portfolio,COUNT(e.customer) AS login_count,strftime(MAX(e."at"),'%Y-%m-%dT%H:%M:%S.%gZ') AS last_login FROM candidates c LEFT JOIN events e ON e.customer=c.key AND e.type='login' AND e."at" >= CAST($2 AS TIMESTAMP) AND e."at" < CAST($3 AS TIMESTAMP) GROUP BY c.id,c.name,c.portfolio`;
    const sql = {
      enrichment: `WITH candidates AS (SELECT * FROM customers WHERE portfolio=$1 ORDER BY id LIMIT 25) ${aggregate} ORDER BY c.id`,
      ranking: `WITH candidates AS (SELECT * FROM customers WHERE portfolio=$1) ${aggregate} ORDER BY COUNT(e.customer) DESC,c.id LIMIT 25`,
      materializedEnrichment:
        'SELECT id,name,portfolio,login_count,last_login FROM metrics WHERE portfolio=$1 ORDER BY id LIMIT 25',
      materializedRanking:
        'SELECT id,name,portfolio,login_count,last_login FROM metrics WHERE portfolio=$1 ORDER BY login_count DESC,id LIMIT 25',
    };
    let materializeMs: number;

    try {
      writer = await writerDb.connect();
      await writer.run(
        'CREATE TABLE customers(id VARCHAR PRIMARY KEY,key VARCHAR,name VARCHAR,portfolio VARCHAR)',
      );
      const appender = await writer.createAppender('customers');

      try {
        for (const r of records) {
          for (const v of [ids.get(r.key)!, r.key, r.name, r.portfolio])
            appender.appendVarchar(v);

          appender.endRow();
        }
      } finally {
        appender.closeSync();
      }

      await writer.run(
        'CREATE INDEX customers_portfolio_id ON customers(portfolio,id); ANALYZE customers',
      );
      const start = performance.now();

      await writer.run(
        `CREATE TABLE metrics AS WITH candidates AS (SELECT * FROM customers) ${aggregate.replaceAll('$2', `'${since}'`).replaceAll('$3', `'${until}'`)}; CREATE INDEX metrics_rank ON metrics(portfolio,login_count,id); ANALYZE metrics`,
      );
      materializeMs = performance.now() - start;
    } finally {
      writer?.closeSync();
      writerDb.closeSync();
    }

    for (let i = 0; i < 5; i++) {
      const db = await DuckDBInstance.create(
        i === 4 ? snapshot : path,
        readOptions,
      );

      instances.push(db);
      connections.push(await db.connect());
    }

    return {
      sql,
      materializeMs,
      replay(statements, fresh) {
        return concurrentMap(statements, 4, async (s, _i, worker) => {
          if (!fresh)
            return (
              await connections[worker]!.runAndReadAll(
                s.sql!,
                s.parameters as DuckDBValue[],
              )
            ).getRows();

          const db = await DuckDBInstance.create(path, readOptions);
          let c: DuckDBConnection | undefined;

          try {
            c = await db.connect();

            return (
              await c.runAndReadAll(s.sql!, s.parameters as DuckDBValue[])
            ).getRows();
          } finally {
            c?.closeSync();
            db.closeSync();
          }
        });
      },
      async colocated(scenario, materialized) {
        const text = materialized
          ? scenario === 'ranking'
            ? sql.materializedRanking
            : sql.materializedEnrichment
          : sql[scenario];
        const rows = (
          await connections[4]!.runAndReadAll(
            text,
            materialized ? ['north'] : ['north', since, until],
          )
        ).getRows();

        return rows.map((r) => ({
          id: String(r[0]),
          data: {
            name: String(r[1]),
            loginCount: String(r[3]),
            lastLogin: r[4] === null ? null : String(r[4]),
          },
        }));
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
