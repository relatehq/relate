import { createHash } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createPostgresStore } from '@relate/postgres';
import {
  initialMigration,
  nativeActionMigration,
} from '../../packages/postgres/src/migrations.js';
import { testDatabaseUrl } from '../support/database.js';
import { testAttribution } from '../support/activity.js';

it('discards legacy observations without inventing account or resource identities', async () => {
  const connectionString = testDatabaseUrl();
  const db = new pg.Client({ connectionString });
  const store = createPostgresStore({ connectionString });

  await db.connect();

  try {
    await db.query('DROP SCHEMA IF EXISTS relate CASCADE');
    await db.query('CREATE SCHEMA relate');
    await db.query(
      'CREATE TABLE relate.migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
    );

    for (const [index, sql] of [
      initialMigration,
      nativeActionMigration,
    ].entries()) {
      await db.query(sql);
      await db.query('INSERT INTO relate.migrations VALUES ($1,$2)', [
        index + 1,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }

    await db.query("INSERT INTO relate.graphs VALUES ('legacy', 'revision')");
    const observation = {
      state: 'present' as const,
      raw: { id: '1' },
      values: { name: 'Unverified legacy customer' },
      token: '1',
      observedAt: 1000,
    };

    await db.query(
      `INSERT INTO relate.objects VALUES ('legacy','customer','crm','reused','shared-service','old-id','1',$1::jsonb)`,
      [JSON.stringify(observation)],
    );
    await db.query(`INSERT INTO relate.value_changes(graph_id,object_type,object_key,origin,state,values,observed_at,fetch_token)
      VALUES ('legacy','customer','old-id','adoption','present','{}',now(),1)`);
    await db.query(`INSERT INTO relate.native_objects
      VALUES ('legacy', 'note', 'native-id', '{"name":"Keep me"}', 1000)`);
    await store.migrate();
    await store.migrate();
    expect(
      (
        await db.query(
          "SELECT values FROM relate.native_objects WHERE object_key='native-id'",
        )
      ).rows,
    ).toEqual([{ values: { name: 'Keep me' } }]);
    const scope = {
      graphId: 'legacy',
      definitionRevision: 'revision',
      objectDefinitionId: 'customer',
      sourceDefinitionId: 'crm',
      connectionId: 'reused',
      resourceId: 'records',
      partition: 'shared-service' as const,
      providerAccountId: 'account-a',
    };

    expect(await store.load(scope, 'old-id')).toBeUndefined();
    expect(await store.resolve(scope, '1')).toBeUndefined();
    expect(await store.scan(scope, { limit: 10 })).toEqual({
      objects: [],
      hasMore: false,
    });
    const application = { ...scope, providerAccountId: null };

    expect(await store.load(application, 'old-id')).toBeUndefined();
    expect(await store.resolve(application, '1')).toBeUndefined();
    expect(await store.scan(application, { limit: 10 })).toEqual({
      objects: [],
      hasMore: false,
    });
    const appObject = await store.accept(application, {
      attribution: testAttribution(),
      adopt: true,
      sourceRecordId: '1',
      observation,
    });

    expect(appObject.object.objectId).not.toBe('old-id');
    const restarted = createPostgresStore({ connectionString });

    try {
      expect(await restarted.resolve(application, '1')).toEqual(
        appObject.object,
      );
    } finally {
      await restarted.close();
    }

    const adopted = await store.accept(scope, {
      attribution: testAttribution(),
      adopt: true,
      sourceRecordId: '1',
      observation,
    });

    expect(adopted.object.objectId).not.toBe('old-id');
    expect(adopted.object.objectId).not.toBe(appObject.object.objectId);
    const other = await store.accept(
      { ...scope, providerAccountId: 'account-b' },
      {
        attribution: testAttribution(),
        adopt: true,
        sourceRecordId: '1',
        observation,
      },
    );

    expect(other.object.objectId).not.toBe(adopted.object.objectId);
    expect(
      (
        await db.query(
          "SELECT provider_account_id FROM relate.objects WHERE object_key='old-id'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT change_id FROM relate.object_versions WHERE object_key='old-id'",
        )
      ).rows,
    ).toEqual([]);
    // Legacy rows acquire no invented provenance or history.
    expect(
      (
        await db.query(
          "SELECT adopted_by_kind, adopted_at FROM relate.objects WHERE object_key='old-id'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM relate.feed_entries WHERE object_key='old-id'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  } finally {
    await store.close();
    await db.end();
  }
});
