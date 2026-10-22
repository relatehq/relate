import assert from 'node:assert/strict';
import pg from 'pg';
import type { Customer, Row } from '../model.js';
import { since, until } from '../model.js';
import type { Statement } from './capture.js';
import { concurrentMap } from './capture.js';

export type Scenario = 'enrichment' | 'ranking';
export interface Database {
  replay(statements: Statement[], fresh: boolean): Promise<unknown[][][]>;
  colocated(scenario: Scenario, materialized: boolean): Promise<Row[]>;
  materializeMs: number;
  sql: Record<string, string>;
  close(): Promise<void>;
}

function client() {
  assert(process.env.RELATE_TEST_DATABASE_URL);
  const connection = new pg.Client({
    connectionString: process.env.RELATE_TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    application_name: 'relate-overhead-direct',
  });
  connection.on('error', () => {});
  return connection;
}

export async function postgresDatabase(
  schema: string,
  records: Customer[],
  ids: Map<string, string>,
): Promise<Database> {
  assert(/^benchmark_[a-f0-9]+$/.test(schema));
  const table = `"${schema}"`;
  const clients: pg.Client[] = [];
  const query = (c: pg.Client, text: string, values: readonly unknown[] = []) =>
    c
      .query({
        text,
        values: [...values],
        rowMode: 'array',
        types: { getTypeParser: () => (v: string) => v },
      })
      .then((r) => r.rows as unknown[][]);

  try {
    for (let i = 0; i < 4; i++) {
      const c = client();
      clients.push(c);
      await c.connect();
      await c.query('SET extra_float_digits = 3');
    }
    const admin = clients[0]!;
    await admin.query(
      `CREATE TABLE ${table}.customers(id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL, portfolio TEXT NOT NULL)`,
    );
    for (let i = 0; i < records.length; i += 4000) {
      const batch = records.slice(i, i + 4000);
      await admin.query(
        `INSERT INTO ${table}.customers VALUES ${batch.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`).join(',')}`,
        batch.flatMap((r) => [ids.get(r.key)!, r.key, r.name, r.portfolio]),
      );
    }
    await admin.query(
      `CREATE INDEX ON ${table}.customers(portfolio, id COLLATE "C"); ANALYZE ${table}.customers`,
    );
    const aggregates = `SELECT c.id, c.name, c.portfolio, COUNT(e.customer) AS login_count, to_char(MAX(e.at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_login FROM candidates c LEFT JOIN ${table}.events e ON e.customer = c.key AND e.type = 'login' AND e.at >= $2::timestamptz AND e.at < $3::timestamptz GROUP BY c.id, c.name, c.portfolio`;
    const sql = {
      enrichment: `WITH candidates AS (SELECT * FROM ${table}.customers WHERE portfolio = $1 ORDER BY id COLLATE "C" LIMIT 25) ${aggregates} ORDER BY c.id COLLATE "C"`,
      ranking: `WITH candidates AS (SELECT * FROM ${table}.customers WHERE portfolio = $1) ${aggregates} ORDER BY COUNT(e.customer) DESC, c.id COLLATE "C" LIMIT 25`,
      materializedEnrichment: `SELECT id, name, portfolio, login_count, last_login FROM ${table}.metrics WHERE portfolio = $1 ORDER BY id COLLATE "C" LIMIT 25`,
      materializedRanking: `SELECT id, name, portfolio, login_count, last_login FROM ${table}.metrics WHERE portfolio = $1 ORDER BY login_count DESC, id COLLATE "C" LIMIT 25`,
    };
    const started = performance.now();
    // Fixed-window snapshot alternative: construction cost retained separately.
    await admin.query(
      `CREATE MATERIALIZED VIEW ${table}.metrics AS WITH candidates AS (SELECT * FROM ${table}.customers) ${aggregates.replaceAll('$2', `'${since}'`).replaceAll('$3', `'${until}'`)}`,
    );
    await admin.query(
      `CREATE INDEX ON ${table}.metrics(portfolio, login_count DESC, id COLLATE "C"); ANALYZE ${table}.metrics`,
    );
    const materializeMs = performance.now() - started;
    return {
      sql,
      materializeMs,
      async replay(statements, fresh) {
        return concurrentMap(
          statements,
          4,
          async (statement, _index, worker) => {
            if (!fresh)
              return query(
                clients[worker]!,
                statement.sql!,
                statement.parameters!,
              );
            const c = client();
            try {
              await c.connect();
              await c.query('BEGIN READ ONLY');
              await c.query(
                "SELECT pg_catalog.set_config('statement_timeout', $1::pg_catalog.text, true), pg_catalog.set_config('extra_float_digits', '3', true)",
                ['5000'],
              );
              const result = await query(
                c,
                statement.sql!,
                statement.parameters!,
              );
              await c.query('ROLLBACK');
              return result;
            } finally {
              await c.end();
            }
          },
        );
      },
      async colocated(scenario, materialized) {
        const text = materialized
          ? scenario === 'ranking'
            ? sql.materializedRanking
            : sql.materializedEnrichment
          : sql[scenario];
        const rows = await query(
          clients[0]!,
          text,
          materialized ? ['north'] : ['north', since, until],
        );
        return rows.map((r) => ({
          id: String(r[0]),
          data: {
            name: String(r[1]),
            loginCount: String(r[3]),
            lastLogin: r[4] === null ? null : String(r[4]),
          },
        }));
      },
      async close() {
        await Promise.all(clients.map((c) => c.end()));
      },
    };
  } catch (error) {
    await Promise.allSettled(clients.map((c) => c.end()));
    throw error;
  }
}
