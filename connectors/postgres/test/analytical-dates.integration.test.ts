import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { postgres } from '@relate/connector-postgres';
import { analyticalDatesContract } from '../../../tests/support/analytical-dates-contract.js';
import { testDatabaseUrl } from '../../../tests/support/database.js';

/** Every connector session uses the given timezone, so `to_char` cannot shift days. */
function sessionUrl(timezone: string): string {
  const url = new URL(testDatabaseUrl());

  url.searchParams.set('options', `-c TimeZone=${timezone}`);

  return url.toString();
}

analyticalDatesContract(
  'PostgreSQL analytical dates',
  async (rows, timezone) => {
    const schema = `analytical_dates_${randomUUID().replaceAll('-', '')}`;
    const database = new pg.Client({ connectionString: testDatabaseUrl() });

    await database.connect();
    const connection = postgres({
      connectionId: 'dates',
      url: sessionUrl(timezone),
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
        CREATE TABLE "${schema}".days("customerId" TEXT NOT NULL, day DATE, label TEXT NOT NULL, "loadedAt" TIMESTAMPTZ(3) NOT NULL);`);

      for (const [customer, day] of rows)
        await database.query(
          `INSERT INTO "${schema}".days VALUES ($1, $2::date, 'label', '2026-10-01T00:00:00Z')`,
          // PostgreSQL spells ISO year zero as 1 BC.
          [
            customer,
            day?.startsWith('0000-') ? `0001-${day.slice(5)} BC` : day,
          ],
        );

      return { resource: connection.table('days', { schema }), close };
    } catch (error) {
      await close();
      throw error;
    }
  },
  {
    invalidResults: [
      'infinity',
      '-infinity',
      '10000-01-01',
      '5874897-12-31',
      '0002-01-01 BC',
    ],
  },
);
