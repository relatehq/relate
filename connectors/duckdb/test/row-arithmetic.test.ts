import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdb } from '@relate/connector-duckdb';
import { rowArithmeticContract } from '../../../tests/support/row-arithmetic-contract.js';

rowArithmeticContract('DuckDB row arithmetic', async (rows) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-row-arithmetic-'));
  const path = join(directory, 'data.duckdb');
  const database = await DuckDBInstance.create(path);
  const writer = await database.connect();

  try {
    await writer.run(
      'CREATE TABLE amounts(customerId VARCHAR NOT NULL, a BIGINT, b BIGINT, small INTEGER, x DOUBLE, y DOUBLE)',
    );

    for (const row of rows)
      // Exact text keeps integral doubles such as 1e308 out of BIGINT binding.
      await writer.run(
        'INSERT INTO amounts VALUES (?, ?, ?, ?, CAST(? AS DOUBLE), CAST(? AS DOUBLE))',
        row.map((value, i) =>
          i >= 4 && typeof value === 'number'
            ? Object.is(value, -0)
              ? '-0'
              : String(value)
            : value,
        ),
      );
  } finally {
    writer.closeSync();
    database.closeSync();
  }

  const connection = duckdb({ connectionId: 'arithmetic', path });

  return {
    resource: connection.table('amounts'),
    async close() {
      await connection.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});
