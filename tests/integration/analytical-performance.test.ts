import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import pg from 'pg';
import { createPostgresStore } from '@relate/postgres';
import { runWorkload } from '../performance/analytical-properties/run.js';
import { testDatabaseUrl } from '../support/database.js';

it('measures real PostgreSQL analytical pages and persistence without retaining its graph or removing other graphs', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();
  const sentinel = `benchmark-sentinel-${randomUUID()}`;

  await store.install(sentinel, `sha256:${'0'.repeat(64)}`);
  await store.close();
  const db = new pg.Client({ connectionString: testDatabaseUrl() });

  await db.connect();

  try {
    const before = (
      await db.query('SELECT graph_id FROM relate.graphs ORDER BY graph_id')
    ).rows;
    const result = await runWorkload({
      customers: 12,
      events: 40,
      seed: 42,
      repetitions: 1,
      warmups: 0,
      backend: 'postgres',
      objectStore: 'postgres',
      capture: 'enabled',
      freshness: 'refresh',
    });

    expect(
      result.samples.filter((sample) => sample.status === 'error'),
    ).toEqual([]);
    const ranking = result.samples.find(
      (sample) =>
        sample.mode === 'relate' &&
        sample.scenario === 'ranking' &&
        sample.phase === 'warm',
    )!;

    expect(ranking.counters).toMatchObject({
      candidatesScanned: 12,
      candidatesAdmitted: 9,
      sourceFetches: 12,
      analyticalBatches: 1,
      analyticalStatements: 1,
      computedSlots: 9,
      capturedOperations: 1,
      activityDrops: 0,
    });
    expect(ranking.stages.execution?.count).toBe(1);
    expect(ranking.stages.connectionStartup?.count).toBe(1);
    expect(
      (await db.query('SELECT graph_id FROM relate.graphs ORDER BY graph_id'))
        .rows,
    ).toEqual(before);
  } finally {
    await db.query('DELETE FROM relate.feed_streams WHERE graph_id = $1', [
      sentinel,
    ]);
    await db.query('DELETE FROM relate.graphs WHERE graph_id = $1', [sentinel]);
    await db.end();
  }
});
