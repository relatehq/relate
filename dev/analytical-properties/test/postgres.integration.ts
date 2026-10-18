import { expect, it } from 'vitest';
import pg from 'pg';
import { parity } from './parity.js';

parity('postgres');

it('records why native AVG(decimal) is not the proposed fixed-scale half-even contract', async () => {
  const client = new pg.Client({
    connectionString: process.env.RELATE_TEST_DATABASE_URL,
  });

  await client.connect();

  try {
    const result = await client.query(
      'SELECT AVG(x)::text AS average FROM (VALUES (1.00::numeric(10,2)), (2.00::numeric(10,2)), (2.00::numeric(10,2))) t(x)',
    );

    expect(result.rows[0].average).toBe('1.6666666666666667');
    const rounding = await client.query(
      'SELECT ROUND(1.2345645::numeric, 6)::text AS rounded',
    );

    expect(rounding.rows[0].rounded).toBe('1.234565'); // half-even would be 1.234564
  } finally {
    await client.end();
  }
});
