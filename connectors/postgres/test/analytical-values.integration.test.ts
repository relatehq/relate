import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgres } from '@relate/connector-postgres';
import { analyticalValuesContract } from '../../../tests/support/analytical-values-contract.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';

analyticalValuesContract(
  'PostgreSQL analytical values',
  async ({ events, invoices }) => {
    const schema = `analytical_values_${randomUUID().replaceAll('-', '')}`;
    const database = new pg.Client({ connectionString: testDatabaseUrl() });

    await database.connect();
    const connection = postgres({
      connectionId: 'values',
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
      CREATE TABLE "${schema}".events("customerId" TEXT NOT NULL, region TEXT NOT NULL, "userId" TEXT, amount BIGINT, "occurredAt" TIMESTAMPTZ(3));
      CREATE TABLE "${schema}".invoices("customerId" TEXT NOT NULL, region TEXT NOT NULL, amount BIGINT NOT NULL);`);

      for (const row of events)
        await database.query(
          `INSERT INTO "${schema}".events VALUES ($1, $2, $3, $4, $5)`,
          [...row],
        );

      for (const row of invoices)
        await database.query(
          `INSERT INTO "${schema}".invoices VALUES ($1, $2, $3)`,
          [...row],
        );

      return {
        events: connection.table('events', { schema }),
        invoices: connection.table('invoices', { schema }),
        close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  },
);
