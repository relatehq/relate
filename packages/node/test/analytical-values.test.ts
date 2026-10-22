import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { analyticalValuesContract } from '../../../tests/support/analytical-values-contract.js';

analyticalValuesContract(
  'SQLite analytical values',
  async ({ events, invoices }) => {
    const directory = await mkdtemp(join(tmpdir(), 'relate-values-'));
    const path = join(directory, 'data.sqlite');
    const connection = sqlite({ connectionId: 'values', path });
    const close = async () => {
      await connection.close();
      await rm(directory, { recursive: true, force: true });
    };

    try {
      const database = new DatabaseSync(path);

      try {
        database.exec(`CREATE TABLE events(customerId TEXT NOT NULL, region TEXT NOT NULL, userId TEXT, amount INTEGER, occurredAt TEXT);
        CREATE TABLE invoices(customerId TEXT NOT NULL, region TEXT NOT NULL, amount INTEGER NOT NULL);`);
        const event = database.prepare(
          'INSERT INTO events VALUES (?, ?, ?, ?, ?)',
        );
        const invoice = database.prepare(
          'INSERT INTO invoices VALUES (?, ?, ?)',
        );

        for (const row of events) event.run(...row);

        for (const row of invoices) invoice.run(...row);
      } finally {
        database.close();
      }

      return {
        events: connection.table('events'),
        invoices: connection.table('invoices'),
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  },
);
