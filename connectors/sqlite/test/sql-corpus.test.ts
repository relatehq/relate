import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { sqlCorpusBackendContract } from '../../../tests/support/sql-corpus/backend-contract.js';

sqlCorpusBackendContract('SQLite SQL corpus', async (rows) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-sql-corpus-'));
  const path = join(directory, 'data.sqlite');
  const connection = sqlite({ connectionId: 'corpus', path });
  const close = async () => {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const database = new DatabaseSync(path);

    try {
      database.exec(
        'CREATE TABLE events(customerId TEXT NOT NULL, value INTEGER, label TEXT, userId TEXT, eventType TEXT, occurredAt TEXT, enabled INTEGER, visible INTEGER, "column$identifier" INTEGER, small INTEGER, ratio REAL, preciseAt TEXT)',
      );
      const insert = database.prepare(
        'INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );

      for (const row of rows)
        insert.run(
          ...row.map((value) =>
            typeof value === 'boolean' ? Number(value) : value,
          ),
        );
    } finally {
      database.close();
    }

    return { resource: connection.table('events'), close };
  } catch (error) {
    await close();
    throw error;
  }
});
