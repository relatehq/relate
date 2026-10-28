import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { analyticalDatesContract } from '../../../tests/support/analytical-dates-contract.js';
import type { DateRow } from '../../../tests/support/analytical-dates-contract.js';

async function open(rows: readonly DateRow[]) {
  const directory = await mkdtemp(join(tmpdir(), 'relate-analytical-dates-'));
  const path = join(directory, 'data.sqlite');
  const database = new DatabaseSync(path);

  try {
    database.exec(
      'CREATE TABLE days(customerId TEXT NOT NULL, day TEXT, label TEXT NOT NULL, loadedAt TEXT NOT NULL)',
    );
    const insert = database.prepare(
      "INSERT INTO days VALUES (?, ?, 'label', '2026-10-01T00:00:00.000Z')",
    );

    for (const row of rows) insert.run(...row);
  } finally {
    database.close();
  }

  const connection = sqlite({ connectionId: 'dates', path });

  return {
    resource: connection.table('days'),
    async close() {
      await connection.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

analyticalDatesContract('SQLite analytical dates', open, {
  malformed: [
    '2026-1-01',
    '2026-10-01 ',
    '2026-02-29',
    '2026-10-01T00:00:00Z',
    '10000-01-01',
    'infinity',
    '',
  ],
});
