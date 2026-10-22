import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { DuckDBInstance } from '@duckdb/node-api';
import { postgres } from '@relate/connector-postgres';
import { customers, events } from '../analytical-properties/seed.ts';
import { eventFilter, querySql, normalize } from './queries.mjs';

export async function openFixture(customerCount, eventCount) {
  if (!process.env.RELATE_TEST_DATABASE_URL)
    throw new Error('RELATE_TEST_DATABASE_URL required');

  const dir = await mkdtemp(join(tmpdir(), 'relate-federation-'));
  const schema = `federation_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({
    connectionString: process.env.RELATE_TEST_DATABASE_URL,
  });
  const source = new DatabaseSync(join(dir, 'customers.sqlite'));
  const oracle = new DatabaseSync(':memory:');
  const duck = await DuckDBInstance.create(':memory:');
  const dc = await duck.connect();
  const connector = postgres({
    connectionId: 'federation-benchmark',
    url: process.env.RELATE_TEST_DATABASE_URL,
  });
  let connected = false,
    created = false;
  const close = async () => {
    await connector.close();
    source.close();
    oracle.close();
    dc.closeSync();
    duck.closeSync();

    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);

    if (connected) await client.end();

    await rm(dir, { recursive: true, force: true });
  };

  try {
    await client.connect();
    connected = true;
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(
      `CREATE TABLE "${schema}".events(customer TEXT NOT NULL, type TEXT NOT NULL, at TIMESTAMPTZ(3) NOT NULL); CREATE TABLE "${schema}".invoices(customer TEXT NOT NULL, amount BIGINT, paid BOOLEAN NOT NULL)`,
    );
    source.exec(
      'CREATE TABLE customers(key TEXT PRIMARY KEY, name TEXT NOT NULL, portfolio TEXT NOT NULL); BEGIN',
    );
    oracle.exec(
      'CREATE TABLE customers(key TEXT PRIMARY KEY, name TEXT, portfolio TEXT); CREATE TABLE events(customer TEXT, type TEXT, at TEXT); CREATE TABLE invoices(customer TEXT, amount INTEGER, paid BOOLEAN); BEGIN',
    );
    const records = customers(customerCount);
    const insertSource = source.prepare(
      'INSERT INTO customers VALUES (?, ?, ?)',
    );
    const insertCustomer = oracle.prepare(
      'INSERT INTO customers VALUES (?, ?, ?)',
    );

    for (const row of records) {
      insertSource.run(row.key, row.name, row.portfolio);
      insertCustomer.run(row.key, row.name, row.portfolio);
    }

    source.exec('COMMIT; ANALYZE');
    const hash = createHash('sha256');
    const insertEvent = oracle.prepare('INSERT INTO events VALUES (?, ?, ?)');
    const csv = ['customer,type,at'];
    let batch = [];
    const flush = async (table, values) => {
      const parameters = values
        .map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`)
        .join(',');

      await client.query(
        `INSERT INTO "${schema}".${table} VALUES ${parameters}`,
        values.flat(),
      );
    };

    await client.query('BEGIN');

    for (const row of events(customerCount, eventCount, 42)) {
      const tuple = [row.customer, row.type, row.at];

      insertEvent.run(...tuple);
      batch.push(tuple);
      csv.push(tuple.join(','));
      hash.update(JSON.stringify(tuple));

      if (batch.length === 4000) {
        await flush('events', batch);
        batch = [];
      }
    }

    if (batch.length) await flush('events', batch);

    batch = [];
    const insertInvoice = oracle.prepare(
      'INSERT INTO invoices VALUES (?, ?, ?)',
    );
    const invoiceCount = Math.floor(eventCount / 5);

    for (let i = 0; i < invoiceCount; i++) {
      const tuple = [
        String(i % Math.max(1, customerCount - 2)).padStart(8, '0'),
        i % 17 === 0 ? null : (i * 137) % 100000,
        i % 4 !== 0,
      ];

      insertInvoice.run(tuple[0], tuple[1], Number(tuple[2]));
      batch.push(tuple);
      hash.update(JSON.stringify(tuple));

      if (batch.length === 4000) {
        await flush('invoices', batch);
        batch = [];
      }
    }

    if (batch.length) await flush('invoices', batch);

    await client.query('COMMIT');
    oracle.exec(
      'COMMIT; CREATE INDEX event_key ON events(customer,type,at); CREATE INDEX invoice_key ON invoices(customer,paid); ANALYZE',
    );
    await client.query(
      `CREATE INDEX ON "${schema}".events(customer,type,at); CREATE INDEX ON "${schema}".invoices(customer,paid); ANALYZE "${schema}".events; ANALYZE "${schema}".invoices`,
    );
    const csvPath = join(dir, 'events.csv'),
      parquet = join(dir, 'events.parquet');

    await writeFile(csvPath, csv.join('\n'));
    await dc.run(
      `COPY (SELECT * FROM read_csv('${csvPath}', header=true, columns={'customer':'VARCHAR','type':'VARCHAR','at':'VARCHAR'})) TO '${parquet}' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)`,
    );
    await dc.run('SET threads=4');
    await dc.run(
      `CREATE VIEW file_events AS SELECT * FROM read_parquet('${parquet}')`,
    );
    const version = (await client.query('SHOW server_version')).rows[0]
      .server_version;

    return {
      config: {
        customersPath: join(dir, 'customers.sqlite'),
        eventsPath: parquet,
        schema,
        partitions: 4,
      },
      records,
      resource: connector.table('events', { schema }),
      provenance: {
        customerCount,
        eventCount,
        invoiceCount,
        seed: 42,
        inputSha256: hash.digest('hex'),
        postgresVersion: version,
        sqliteVersion: oracle.prepare('SELECT sqlite_version() AS v').get().v,
      },
      expected(scenario) {
        if (scenario === 'control') return [{ value: 1 }];

        return normalize(
          oracle
            .prepare(querySql(scenario).replaceAll('file_events', 'events'))
            .all(),
        );
      },
      async native(scenario) {
        if (scenario === 'control') return { rows: [{ value: 1 }] };

        const multi = ['multi', 'selective'].includes(scenario);
        const file = multi || scenario === 'ranking-file';
        const selective = scenario === 'selective';
        const filter = selective ? " AND customer = '00000001'" : '';
        const cs = source
          .prepare(
            `SELECT * FROM customers WHERE portfolio='north'${selective ? " AND key='00000001'" : ''}`,
          )
          .all();
        const sql = `SELECT customer, COUNT(*) AS n, MAX("at") AS last_login FROM ${file ? 'file_events' : `"${schema}".events`} WHERE ${eventFilter}${filter} GROUP BY customer`;
        const [es, invoices] = await Promise.all([
          file
            ? dc.runAndReadAll(sql).then((reader) => reader.getRowObjects())
            : client.query(sql).then((result) => result.rows),
          multi
            ? client
                .query(
                  `SELECT customer, SUM(amount)::text AS paid FROM "${schema}".invoices WHERE paid=true${filter} GROUP BY customer`,
                )
                .then((result) => result.rows)
            : [],
        ]);
        const em = new Map(es.map((row) => [row.customer, row]));
        const im = new Map(invoices.map((row) => [row.customer, row]));
        let rows = cs.map((c) => ({
          key: c.key,
          name: c.name,
          login_count: String(em.get(c.key)?.n ?? 0),
          last_login: em.get(c.key)?.last_login ?? null,
          ...(multi ? { paid: String(im.get(c.key)?.paid ?? 0) } : {}),
        }));

        rows.sort(
          (a, b) =>
            Number(b.login_count) - Number(a.login_count) ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
        );

        if (scenario !== 'bulk') rows = rows.slice(0, 25);

        return {
          rows: normalize(rows),
          sourceRows: cs.length + es.length + invoices.length,
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
