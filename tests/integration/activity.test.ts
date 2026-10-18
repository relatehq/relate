import { createPostgresStore } from '@relate/postgres';
import { testDatabaseUrl } from '../support/database.js';
import { activityStoreContract } from '../support/activity-store-contract.js';

activityStoreContract('Postgres activity', async () => {
  const store = createPostgresStore({ connectionString: testDatabaseUrl() });

  await store.migrate();

  return { store, close: () => store.close() };
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { activityId } from '@relate/runtime/storage';
import {
  feedDraft,
  operationDraft,
} from '../support/activity-store-contract.js';

it('serializes final publication across independent source/native connections and survives restart', async () => {
  const connectionString = testDatabaseUrl(),
    store = createPostgresStore({ connectionString });

  await store.migrate();
  const graphId = randomUUID(),
    scope = { graphId, definitionRevision: 'v1' };

  await store.install(graphId, 'v1');
  let closed = false;
  let release!: () => void, staged!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      staged = r;
    });

  try {
    const checkpoint = (await store.activity!.feed.read(graphId)).nextCursor;
    const native = store.native!.transaction(scope, async (tx) => {
      await tx.appendFeed!([feedDraft(graphId)]);
      staged();
      await gate;
    });

    await ready;
    await store.accept(
      {
        ...scope,
        objectDefinitionId: 'customer',
        sourceDefinitionId: 'crm',
        connectionId: 'crm',
        providerAccountId: null,
        partition: 'shared-service',
      },
      {
        sourceRecordId: '1',
        adopt: true,
        observation: {
          state: 'present',
          raw: {},
          values: { name: 'one' },
          observedAt: Date.now(),
          token: await store.beginFetch(),
        },
        provenance: {
          actor: { kind: 'system', id: 'seed' },
          operationId: activityId(),
          context: { requestId: 'source', transport: 'embedded' },
          occurredAt: new Date().toISOString(),
          changeId: activityId(),
        },
      },
    );
    const source = await store.activity!.feed.read(graphId, {
      cursor: checkpoint,
    });

    expect(source.entries.map((e) => e.kind)).toEqual(['adopted']);
    release();
    await native;
    const after = await store.activity!.feed.read(graphId, {
      cursor: source.nextCursor,
    });

    expect(after.entries.map((e) => e.kind)).toEqual(['created']);
    expect(BigInt(after.entries[0]!.position)).toBeGreaterThan(
      BigInt(source.entries[0]!.position),
    );
    await store.close();
    closed = true;
    const reopened = createPostgresStore({ connectionString });

    try {
      expect(
        (
          await reopened.activity!.feed.read(graphId, {
            cursor: source.nextCursor,
          })
        ).entries,
      ).toEqual(after.entries);
    } finally {
      await reopened.close();
    }
  } finally {
    release();

    if (!closed) await store.close();
  }
});
it('rolls back domain writes on feed insertion failure and operations on lineage failure', async () => {
  const connectionString = testDatabaseUrl(),
    store = createPostgresStore({ connectionString }),
    db = new pg.Client({ connectionString });

  await store.migrate();
  await db.connect();
  const graphId = randomUUID(),
    scope = { graphId, definitionRevision: 'v1' };

  await store.install(graphId, 'v1');

  try {
    await db.query(
      "CREATE FUNCTION relate.reject_activity_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
    );
    await db.query(
      'CREATE TRIGGER reject_activity BEFORE INSERT ON relate.feed_entries FOR EACH ROW EXECUTE FUNCTION relate.reject_activity_test()',
    );
    await expect(
      store.native!.transaction(scope, async (tx) => {
        const draft = feedDraft(graphId);

        await tx.insert({
          objectDefinitionId: 'review',
          objectId: 'new',
          values: {},
          createdAt: Date.now(),
          provenance: {
            kind: 'created',
            actor: { kind: 'principal', id: 'ana' },
            at: new Date().toISOString(),
            invocationId: draft.invocationId!,
          },
        });
        await tx.claim('add', 'key');
        await tx.saveInvocation({
          actionDefinitionId: 'add',
          idempotencyKey: 'key',
          actorId: 'ana',
          reads: [],
          input: {},
          receipt: {
            state: 'succeeded',
            invocationId: draft.invocationId!,
            output: {},
          },
        });
        await tx.appendFeed!([draft]);
      }),
    ).rejects.toThrow();
    expect(
      await store.native!.provenance(scope, {
        objectDefinitionId: 'review',
        objectId: 'new',
      }),
    ).toBeUndefined();
    expect(
      await store.native!.loadInvocation(scope, 'add', 'key'),
    ).toBeUndefined();
    expect((await store.activity!.feed.read(graphId)).entries).toEqual([]);
    await db.query('DROP TRIGGER reject_activity ON relate.feed_entries');
    await db.query(
      'CREATE TRIGGER reject_activity_lineage BEFORE INSERT ON relate.operation_objects FOR EACH ROW EXECUTE FUNCTION relate.reject_activity_test()',
    );
    await expect(
      store.activity!.appendOperations(graphId, [operationDraft(graphId)]),
    ).rejects.toThrow();
    expect((await store.activity!.operations.list(graphId)).entries).toEqual(
      [],
    );
  } finally {
    await db.query(
      'DROP TRIGGER IF EXISTS reject_activity ON relate.feed_entries',
    );
    await db.query(
      'DROP TRIGGER IF EXISTS reject_activity_lineage ON relate.operation_objects',
    );
    await db.query('DROP FUNCTION IF EXISTS relate.reject_activity_test()');
    await db.end();
    await store.close();
  }
});
it('enforces typed feed variants in SQL independently of runtime validation', async () => {
  const connectionString = testDatabaseUrl(),
    store = createPostgresStore({ connectionString }),
    db = new pg.Client({ connectionString });

  await store.migrate();
  await db.connect();
  const graphId = randomUUID(),
    scope = { graphId, definitionRevision: 'v1' };

  await store.install(graphId, 'v1');

  try {
    await store.native!.transaction(scope, async (tx) => {
      await tx.appendFeed!([
        feedDraft(graphId),
        feedDraft(graphId, 'invocation-succeeded'),
      ]);
    });

    for (const mutation of [
      "kind='made-up'",
      'object_type=NULL',
      'invocation_id=NULL',
      "actor_kind='source'",
    ])
      await expect(
        db.query(
          `UPDATE relate.feed_entries SET ${mutation} WHERE graph_id=$1 AND kind='created'`,
          [graphId],
        ),
      ).rejects.toThrow();

    await expect(
      db.query(
        "UPDATE relate.feed_entries SET failure_code='oops' WHERE graph_id=$1 AND kind='invocation-succeeded'",
        [graphId],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        "UPDATE relate.feed_entries SET position=1 WHERE graph_id=$1 AND kind='invocation-succeeded'",
        [graphId],
      ),
    ).rejects.toThrow();
  } finally {
    await db.end();
    await store.close();
  }
});
