import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { analyticalOrderContract } from '../../../tests/support/analytical-order-contract.js';

analyticalOrderContract('SQLite', async ({ members, secret, connectionId }) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-scope-query-'));
  const path = join(directory, 'events.sqlite');
  const connection = sqlite({ connectionId, path });
  const close = async () => {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const database = new DatabaseSync(path);

    try {
      database.exec(
        'CREATE TABLE events(customerId TEXT NOT NULL, amount INTEGER NOT NULL, secret TEXT NOT NULL)',
      );
      const insert = database.prepare('INSERT INTO events VALUES (?, ?, ?)');

      for (const [id, amount] of members)
        if (amount !== null) insert.run(id, amount, secret);
    } finally {
      database.close();
    }

    return { resource: connection.table('events'), close };
  } catch (error) {
    await close();
    throw error;
  }
});
