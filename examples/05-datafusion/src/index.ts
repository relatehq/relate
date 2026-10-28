import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DuckDBInstance } from '@duckdb/node-api';
import { startApp } from '@relate/node';
import { createApp } from './app.js';

const endpoint = process.env.RELATE_S3_ENDPOINT ?? 'http://127.0.0.1:5033';
const bucket = `relate-demo-${Date.now()}`;
const directory = await mkdtemp(join(tmpdir(), 'relate-datafusion-demo-'));

try {
  const parquet = join(directory, 'delivery.parquet');
  // DuckDB is used only to create this tutorial's tiny Parquet fixture.
  const database = await DuckDBInstance.create(':memory:');
  const writer = await database.connect();

  try {
    await writer.run(
      `COPY (SELECT * FROM (VALUES ('summer', 9007199254740993::BIGINT), ('summer', 2), ('winter', 700), ('unrelated', 999999)) AS t(campaignId, costMicros)) TO '${parquet}' (FORMAT PARQUET)`,
    );
  } finally {
    writer.closeSync();
    database.closeSync();
  }

  // Moto accepts unsigned setup requests; DataFusion uses its real signed S3 client.
  for (const [url, body] of [
    [`${endpoint}/${bucket}`, undefined],
    [`${endpoint}/${bucket}/delivery.parquet`, await readFile(parquet)],
  ] as const) {
    const response = await fetch(url, {
      method: 'PUT',
      ...(body ? { body } : {}),
    });

    if (!response.ok)
      throw new Error(`Local S3 seed failed (${response.status})`);
  }

  const sqlitePath = join(directory, 'budgets.sqlite');
  const sqlite = new DatabaseSync(sqlitePath);

  sqlite.exec(
    `CREATE TABLE budgets(campaignId TEXT NOT NULL, amountMicros INTEGER NOT NULL); INSERT INTO budgets VALUES ('summer', 10000000000000000), ('winter', 1000)`,
  );
  sqlite.close();
  const runtime = await startApp(createApp(endpoint, sqlitePath, bucket));

  try {
    const actor = {
      id: 'ana',
      roles: ['reader', 'analyst', 'editor'],
      claims: {},
    };
    const client = runtime.as(actor);

    for (const [externalId, name] of [
      ['summer', 'Summer launch'],
      ['winter', 'Winter launch'],
    ])
      await client.actions.addCampaign({
        input: { externalId: externalId!, name: name! },
        idempotencyKey: externalId!,
      });

    const page = await runtime.operations(actor).query('campaign', {
      select: ['name', 'spend', 'budget'],
      compute: { impressions: { sql: 'SELECT COUNT(*) FROM self.events' } },
    });
    const rows = page.data
      .map((row) => row.data)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    assert.deepEqual(rows, [
      {
        name: 'Summer launch',
        spend: '9007199254740995',
        budget: '10000000000000000',
        impressions: '2',
      },
      { name: 'Winter launch', spend: '700', budget: '1000', impressions: '1' },
    ]);
    const denied = await runtime
      .operations({ ...actor, roles: ['reader'] })
      .query('campaign', { select: ['name', 'spend'] });

    assert.ok(denied.data.every((row) => !Object.hasOwn(row.data, 'spend')));
    console.log(JSON.stringify(rows, null, 2));
    console.log(
      'Verified S3 DataFusion + SQLite calculations and denied dataset access.',
    );
  } finally {
    await runtime.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
