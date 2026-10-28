import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgres } from '@relate/connector-postgres';
import { sqlPropertyBackendContract } from '../../../tests/support/sql-properties/backend-contract.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';

sqlPropertyBackendContract('PostgreSQL', async () => {
  const schema = `sql_properties_${randomUUID().replaceAll('-', '')}`;
  const database = new pg.Client({ connectionString: testDatabaseUrl() });

  await database.connect();
  // A locale collation orders 'B' after 'a'; results must still use byte order.
  await database.query(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".events("customerId" TEXT NOT NULL, n BIGINT, small INTEGER, ratio DOUBLE PRECISION, label TEXT COLLATE "und-x-icu", flag BOOLEAN, at TIMESTAMPTZ(6), day DATE);`);
  const connection = postgres({
    connectionId: 'properties',
    url: testDatabaseUrl(),
  });

  return {
    resource: connection.table('events', { schema }),
    async replace(rows) {
      await database.query('BEGIN');
      await database.query(`DELETE FROM "${schema}".events`);

      for (const row of rows)
        await database.query(
          `INSERT INTO "${schema}".events VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            row.customerId,
            row.n === null ? null : String(row.n),
            row.small,
            row.ratio,
            row.label,
            row.flag,
            row.at,
            // PostgreSQL spells ISO year zero as 1 BC.
            row.day?.startsWith('0000-')
              ? `0001-${row.day.slice(5)} BC`
              : row.day,
          ],
        );

      await database.query('COMMIT');
    },
    async close() {
      try {
        await connection.close();
        await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await database.end();
      }
    },
  };
});
