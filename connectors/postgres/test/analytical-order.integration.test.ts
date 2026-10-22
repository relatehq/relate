import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgres } from '@relate/connector-postgres';
import { analyticalOrderContract } from '../../../tests/support/analytical-order-contract.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';

analyticalOrderContract(
  'PostgreSQL',
  async ({ members, secret, connectionId }) => {
    const schema = `analytical_order_${randomUUID().replaceAll('-', '')}`;
    const database = new pg.Client({ connectionString: testDatabaseUrl() });

    await database.connect();
    const connection = postgres({ connectionId, url: testDatabaseUrl() });
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
      CREATE TABLE "${schema}".events("customerId" TEXT NOT NULL, amount BIGINT NOT NULL, secret TEXT NOT NULL)`);
      const rows = members.filter(
        (row): row is readonly [string, bigint] => row[1] !== null,
      );

      await database.query(
        `INSERT INTO "${schema}".events SELECT * FROM unnest($1::text[], $2::bigint[], $3::text[])`,
        [
          rows.map(([id]) => id),
          rows.map(([, amount]) => amount.toString()),
          rows.map(() => secret),
        ],
      );

      return { resource: connection.table('events', { schema }), close };
    } catch (error) {
      await close();
      throw error;
    }
  },
);
