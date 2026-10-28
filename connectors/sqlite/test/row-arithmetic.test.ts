import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { rowArithmeticContract } from '../../../tests/support/row-arithmetic-contract.js';

rowArithmeticContract('SQLite row arithmetic', async (rows) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-row-arithmetic-'));
  const path = join(directory, 'data.sqlite');
  const database = new DatabaseSync(path);

  try {
    database.exec(
      'CREATE TABLE amounts(customerId TEXT NOT NULL, a INTEGER, b INTEGER, small INTEGER, x REAL, y REAL)',
    );
    const insert = database.prepare(
      'INSERT INTO amounts VALUES (?, ?, ?, ?, ?, ?)',
    );

    for (const row of rows) insert.run(...row);
  } finally {
    database.close();
  }

  const connection = sqlite({ connectionId: 'arithmetic', path });

  return {
    resource: connection.table('amounts'),
    async close() {
      await connection.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
