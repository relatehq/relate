import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdb } from '@relate/connector-duckdb';
import { sqlCorpusBackendContract } from '../../../tests/support/sql-corpus/backend-contract.js';

sqlCorpusBackendContract('DuckDB SQL corpus', async (rows) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-duckdb-corpus-'));
  const path = join(directory, 'data.duckdb');
  const connection = duckdb({ connectionId: 'corpus', path });
  const close = async () => {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  };

  try {
    const database = await DuckDBInstance.create(path);
    const writer = await database.connect();

    try {
      await writer.run(
        'CREATE TABLE events(customerId VARCHAR NOT NULL, value BIGINT, label VARCHAR, userId VARCHAR, eventType VARCHAR, occurredAt TIMESTAMP_MS, enabled BOOLEAN, visible BOOLEAN, "column$identifier" INTEGER, small INTEGER, ratio DOUBLE, preciseAt TIMESTAMP)',
      );

      for (const row of rows)
        await writer.run(
          'INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [...row],
        );
    } finally {
      writer.closeSync();
      database.closeSync();
    }

    return { resource: connection.table('events'), close };
  } catch (error) {
    await close();
    throw error;
  }
});
