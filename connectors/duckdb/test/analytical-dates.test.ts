import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdb } from '@relate/connector-duckdb';
import { analyticalDatesContract } from '../../../tests/support/analytical-dates-contract.js';

analyticalDatesContract(
  'DuckDB analytical dates',
  async (rows) => {
    const directory = await mkdtemp(join(tmpdir(), 'relate-analytical-dates-'));
    const path = join(directory, 'data.duckdb');
    const database = await DuckDBInstance.create(path);
    const writer = await database.connect();

    try {
      await writer.run(
        'CREATE TABLE days(customerId VARCHAR NOT NULL, day DATE, label VARCHAR NOT NULL, loadedAt TIMESTAMP_MS NOT NULL)',
      );

      for (const row of rows)
        await writer.run(
          "INSERT INTO days VALUES (?, CAST(? AS DATE), 'label', TIMESTAMP_MS '2026-10-01 00:00:00')",
          [...row],
        );
    } finally {
      writer.closeSync();
      database.closeSync();
    }

    const connection = duckdb({ connectionId: 'dates', path });

    return {
      resource: connection.table('days'),
      async close() {
        await connection.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  },
  { invalidResults: ['infinity', '-infinity', '10000-01-01'] },
);
