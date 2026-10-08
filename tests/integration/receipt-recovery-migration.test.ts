import { createHash } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import { createPostgresStore } from '@relate/postgres';
import {
  initialMigration,
  nativeActionMigration,
  providerAccountMigration,
} from '../../packages/postgres/src/migrations.js';
import {
  graph,
  AddAccountReview,
  customers,
  invoices,
  ana,
} from '../support/native-action-model.js';
import { testDatabaseUrl } from '../support/database.js';

it('preserves legacy receipt/key evidence without inventing an actor or allowing execution again', async () => {
  const connectionString = testDatabaseUrl();
  const db = new pg.Client({ connectionString });
  const store = createPostgresStore({ connectionString });
  const model = compile(graph);
  const input = { customer: 'legacy-customer', note: 'Original' };
  const receipt = {
    invocationId: 'legacy-invocation',
    state: 'succeeded',
    output: { reviewId: 'legacy-review' },
  };

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
      providerAccountMigration,
    ].entries()) {
      await db.query(sql);
      await db.query('INSERT INTO relate.migrations VALUES ($1,$2)', [
        index + 1,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }

    await db.query('INSERT INTO relate.graphs VALUES ($1,$2)', [
      'legacy',
      model.definitionRevision,
    ]);
    await db.query(
      'INSERT INTO relate.native_invocations(graph_id,action_id,idempotency_key,invocation_id,input,receipt) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)',
      [
        'legacy',
        AddAccountReview.id,
        'old-key',
        receipt.invocationId,
        JSON.stringify(input),
        JSON.stringify(receipt),
      ],
    );
    await store.migrate();
    await store.migrate();
    let executions = 0;
    const runtime = createRuntime({
      graphId: 'legacy',
      model,
      store,
      sources: Object.fromEntries(
        [customers, invoices].map((source) => [
          source.id,
          {
            connectionId: source.id,
            providerAccountId: 'account',
            authorization: 'shared-service' as const,
            connector: {
              identify: async () => 'account',
              async fetch() {
                throw new Error(
                  'Legacy recovery must reject before reading sources',
                );
              },
            },
          },
        ]),
      ),
      actionHandlers: {
        [AddAccountReview.id]: async () => {
          executions++;

          return receipt.output;
        },
      },
    });

    await expect(
      runtime.invoke(ana, AddAccountReview.id, {
        input,
        idempotencyKey: 'old-key',
      }),
    ).rejects.toMatchObject({ code: 'denied' });
    await expect(
      runtime.getReceipt(ana, AddAccountReview.id, receipt.invocationId),
    ).rejects.toMatchObject({ code: 'denied' });
    expect(executions).toBe(0);
    expect(
      await store.native!.loadInvocation(
        { graphId: 'legacy', definitionRevision: model.definitionRevision },
        AddAccountReview.id,
        'old-key',
      ),
    ).toMatchObject({ actorId: null, reads: null, receipt, input });
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS count FROM relate.native_invocations',
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  } finally {
    await store.close();
    await db.end();
  }
});
