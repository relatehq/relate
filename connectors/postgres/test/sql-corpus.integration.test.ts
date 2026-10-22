import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgres } from '@relate/connector-postgres';
import { sqlCorpusBackendContract } from '../../../tests/support/sql-corpus/backend-contract.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';

sqlCorpusBackendContract('PostgreSQL SQL corpus', async (rows) => {
  const schema = `sql_corpus_${randomUUID().replaceAll('-', '')}`;
  const database = new pg.Client({ connectionString: testDatabaseUrl() });

  await database.connect();
  const connection = postgres({
    connectionId: 'corpus',
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
      CREATE TABLE "${schema}".events("customerId" TEXT NOT NULL, value BIGINT, label TEXT, "userId" TEXT, "eventType" TEXT, "occurredAt" TIMESTAMPTZ(3), enabled BOOLEAN, visible BOOLEAN, "column$identifier" INTEGER, small INTEGER, ratio DOUBLE PRECISION, "preciseAt" TIMESTAMPTZ(6));`);

    for (const row of rows)
      await database.query(
        `INSERT INTO "${schema}".events VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [...row],
      );

    return { resource: connection.table('events', { schema }), close };
  } catch (error) {
    await close();
    throw error;
  }
});
