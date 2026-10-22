import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { sqlPropertyBackendContract } from '../../../tests/support/sql-properties/backend-contract.js';

sqlPropertyBackendContract('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-sql-properties-'));
  const path = join(directory, 'data.sqlite');
  const database = new DatabaseSync(path);

  database.exec(
    'CREATE TABLE events(customerId TEXT NOT NULL, n INTEGER, small INTEGER, ratio REAL, label TEXT, flag INTEGER, at TEXT)',
  );
  const connection = sqlite({ connectionId: 'properties', path });
  const insert = database.prepare(
    'INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  return {
    resource: connection.table('events'),
    async replace(rows) {
      database.exec('BEGIN; DELETE FROM events');

      for (const row of rows)
        insert.run(
          row.customerId,
          row.n,
          row.small,
          row.ratio,
          row.label,
          row.flag === null ? null : Number(row.flag),
          row.at,
        );

      database.exec('COMMIT');
    },
    async close() {
      try {
        database.close();
        await connection.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
});
