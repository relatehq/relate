import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgres } from '@relate/connector-postgres';
import { rowArithmeticContract } from '../../../tests/support/row-arithmetic-contract.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';

rowArithmeticContract('PostgreSQL row arithmetic', async (rows) => {
  const schema = `row_arithmetic_${randomUUID().replaceAll('-', '')}`;
  const database = new pg.Client({ connectionString: testDatabaseUrl() });

  await database.connect();
  const connection = postgres({
    connectionId: 'arithmetic',
    url: testDatabaseUrl(),
  });
  const close = async () => {
    try {
      await connection.close();
      await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await database.end();
    }
  };

  try {
    await database.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".amounts("customerId" TEXT NOT NULL, a BIGINT, b BIGINT, small INTEGER, x DOUBLE PRECISION, y DOUBLE PRECISION);`);

    for (const row of rows)
      await database.query(
        `INSERT INTO "${schema}".amounts VALUES ($1, $2, $3, $4, $5::float8, $6::float8)`,
        row.map((value) =>
          typeof value === 'number' && !Number.isInteger(value)
            ? value.toPrecision(17)
            : value,
        ),
      );

    return { resource: connection.table('amounts', { schema }), close };
  } catch (error) {
    await close();
    throw error;
  }
});
