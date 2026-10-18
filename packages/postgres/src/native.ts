import type pg from 'pg';
import type {
  FeedDraft,
  NativeStore,
  NativeScope,
  NativeRecord,
  NativeInvocation,
  NativeScanOptions,
  NativeScanResult,
} from '@relate/runtime/storage';
import {
  NativeConflict,
  NativeCommitUncertain,
  StorageUnavailable,
} from '@relate/runtime/storage';
import { validateFeedDraft } from '@relate/runtime/storage';
import { storageError, transactionRejected } from './errors.js';
import { publishFeed } from './activity.js';

export function createNativePostgresStore(pool: pg.Pool): NativeStore {
  function invocation(
    row: pg.QueryResultRow | undefined,
  ): NativeInvocation | undefined {
    return row?.receipt
      ? {
          actionDefinitionId: row.action_id,
          idempotencyKey: row.idempotency_key,
          actorId: row.actor_id ?? null,
          actorKind: row.actor_kind ?? null,
          operationId: row.operation_id ?? null,
          requestId: row.request_id ?? null,
          transport: row.transport ?? null,
          definitionRevision: row.definition_revision ?? null,
          startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
          completedAt: row.completed_at
            ? new Date(row.completed_at).getTime()
            : null,
          reads: row.reads ?? null,
          input: row.input,
          receipt: row.receipt,
        }
      : undefined;
  }

  function record(row: pg.QueryResultRow): NativeRecord {
    return {
      objectDefinitionId: row.object_type,
      objectId: row.object_key,
      values: row.values,
      createdAt: Number(row.created_at),
    };
  }

  async function load(
    client: Pick<pg.Pool, 'query'> | pg.PoolClient,
    scope: NativeScope,
    type: string,
    id: string,
  ): Promise<NativeRecord | undefined> {
    const result = await client.query(
      `SELECT n.object_type,n.object_key,n.values,n.created_at FROM relate.native_objects n
       JOIN relate.graphs g USING (graph_id)
       WHERE n.graph_id=$1 AND g.definition_revision=$2 AND n.object_type=$3 AND n.object_key=$4`,
      [scope.graphId, scope.definitionRevision, type, id],
    );
    const row = result.rows[0];

    return row ? record(row) : undefined;
  }

  async function scan(
    client: Pick<pg.Pool, 'query'> | pg.PoolClient,
    scope: NativeScope,
    type: string,
    options: NativeScanOptions,
  ): Promise<NativeScanResult> {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new Error('Invalid scan limit');

    const result = await client.query(
      `SELECT n.object_type,n.object_key,n.values,n.created_at FROM relate.native_objects n
       JOIN relate.graphs g USING(graph_id)
       WHERE n.graph_id=$1 AND g.definition_revision=$2 AND n.object_type=$3
       AND ($4::text IS NULL OR n.object_key COLLATE "C" > $4::text COLLATE "C")
       ORDER BY n.object_key COLLATE "C" LIMIT $5`,
      [
        scope.graphId,
        scope.definitionRevision,
        type,
        options.after ?? null,
        options.limit + 1,
      ],
    );

    return {
      objects: result.rows.slice(0, options.limit).map(record),
      hasMore: result.rows.length > options.limit,
    };
  }

  return {
    scan: (scope, type, options) => scan(pool, scope, type, options),
    async loadInvocation(scope, actionDefinitionId, idempotencyKey) {
      const result = await pool.query(
        `SELECT n.* FROM relate.invocations n JOIN relate.graphs g USING(graph_id) WHERE n.graph_id=$1 AND g.definition_revision=$2 AND n.action_id=$3 AND n.idempotency_key=$4`,
        [
          scope.graphId,
          scope.definitionRevision,
          actionDefinitionId,
          idempotencyKey,
        ],
      );

      return invocation(result.rows[0]);
    },
    load: (scope, type, id) => load(pool, scope, type, id),
    async provenance(scope, object) {
      const result = await pool.query(
        `SELECT n.created_at,n.created_by_kind,n.created_by_id,n.created_invocation_id FROM relate.native_objects n
         JOIN relate.graphs g USING (graph_id)
         WHERE n.graph_id=$1 AND g.definition_revision=$2 AND n.object_type=$3 AND n.object_key=$4`,
        [
          scope.graphId,
          scope.definitionRevision,
          object.objectDefinitionId,
          object.objectId,
        ],
      );
      const row = result.rows[0];

      if (!row) return undefined;

      // The object's own insertion time and actor snapshot, never its receipt.
      return row.created_by_kind !== null
        ? {
            kind: 'created',
            actor: { kind: row.created_by_kind, id: row.created_by_id },
            at: new Date(Number(row.created_at)).toISOString(),
            invocationId: row.created_invocation_id,
          }
        : { kind: 'unknown' };
    },
    async transaction(scope, operation) {
      const client = await pool.connect().catch((error: unknown) => {
        throw storageError(error);
      });
      let active = true;
      let committing = false;
      let rolledBack = false;
      let clientFailure: Error | undefined;
      let rejectClient!: (error: Error) => void;
      const clientFailed = new Promise<never>((_, reject) => {
        rejectClient = reject;
      });

      // Failures can arrive before the callback race is installed.
      void clientFailed.catch(() => {});
      // Checked-out clients can fail while the handler is awaiting non-PG I/O.
      const onError = (error: Error) => {
        clientFailure ??= error;
        active = false;
        rejectClient(clientFailure);
      };

      client.on('error', onError);
      const claimed = new Set<string>();
      const staged: FeedDraft[] = [];
      let savepointSequence = 0;
      const keyFor = (action: string, key: string) =>
        JSON.stringify([action, key]);
      const check = () => {
        if (!active) throw new Error('Inactive native transaction');
      };

      try {
        await client.query('BEGIN');
        const installed = await client.query(
          'SELECT 1 FROM relate.graphs WHERE graph_id=$1 AND definition_revision=$2 FOR SHARE',
          [scope.graphId, scope.definitionRevision],
        );

        if (!installed.rowCount) throw new Error('Model is not installed');

        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [JSON.stringify(['native', scope.graphId])],
        );
        const result = await Promise.race([
          operation({
            async scan(type, options) {
              check();

              return scan(client, scope, type, options);
            },
            async savepoint(operation) {
              check();
              const name = `native_effects_${++savepointSequence}`;
              const claims = new Set(claimed);
              const stagedLength = staged.length;

              await client.query(`SAVEPOINT ${name}`);

              try {
                const result = await operation();

                check();
                await client.query(`RELEASE SAVEPOINT ${name}`);

                return result;
              } catch (error) {
                check();
                await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
                check();
                await client.query(`RELEASE SAVEPOINT ${name}`);
                claimed.clear();

                for (const key of claims) claimed.add(key);

                staged.length = stagedLength;

                throw error;
              }
            },
            async load(type, id) {
              check();

              return load(client, scope, type, id);
            },
            async insert(record, creation) {
              check();
              await client.query(
                'INSERT INTO relate.native_objects(graph_id,object_type,object_key,values,created_at,created_by_kind,created_by_id,created_invocation_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
                [
                  scope.graphId,
                  record.objectDefinitionId,
                  record.objectId,
                  JSON.stringify(record.values),
                  record.createdAt,
                  creation.actor.kind,
                  creation.actor.id,
                  creation.invocationId,
                ],
              );
            },
            async appendFeed(drafts) {
              check();

              for (const draft of drafts) validateFeedDraft(draft);

              // Staged in order; published as the final work before COMMIT.
              staged.push(...structuredClone(drafts));
            },
            async claim(action, key) {
              check();
              const row = await client.query(
                'INSERT INTO relate.invocations(graph_id,action_id,idempotency_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING action_id',
                [scope.graphId, action, key],
              );

              if (!row.rowCount) {
                const existing = invocation(
                  (
                    await client.query(
                      'SELECT * FROM relate.invocations WHERE graph_id=$1 AND action_id=$2 AND idempotency_key=$3',
                      [scope.graphId, action, key],
                    )
                  ).rows[0],
                );

                if (!existing) throw new NativeConflict();

                return existing;
              }

              claimed.add(keyFor(action, key));
            },
            async findInvocation(action, id) {
              check();

              return invocation(
                (
                  await client.query(
                    'SELECT * FROM relate.invocations WHERE graph_id=$1 AND action_id=$2 AND invocation_id=$3',
                    [scope.graphId, action, id],
                  )
                ).rows[0],
              );
            },
            async saveInvocation(invocation) {
              check();

              if (
                !claimed.delete(
                  keyFor(
                    invocation.actionDefinitionId,
                    invocation.idempotencyKey,
                  ),
                )
              )
                throw new Error('Invocation was not claimed');

              await client.query(
                'UPDATE relate.invocations SET invocation_id=$4,input=$5::jsonb,receipt=$6::jsonb,actor_id=$7,reads=$8::jsonb,actor_kind=$9,operation_id=$10,request_id=$11,transport=$12,definition_revision=$13,started_at=$14,completed_at=$15 WHERE graph_id=$1 AND action_id=$2 AND idempotency_key=$3',
                [
                  scope.graphId,
                  invocation.actionDefinitionId,
                  invocation.idempotencyKey,
                  invocation.receipt.invocationId,
                  JSON.stringify(invocation.input),
                  JSON.stringify(invocation.receipt),
                  invocation.actorId,
                  JSON.stringify(invocation.reads),
                  invocation.actorKind ?? null,
                  invocation.operationId ?? null,
                  invocation.requestId ?? null,
                  invocation.transport ?? null,
                  invocation.definitionRevision ?? null,
                  invocation.startedAt != null
                    ? new Date(invocation.startedAt)
                    : null,
                  invocation.completedAt != null
                    ? new Date(invocation.completedAt)
                    : null,
                ],
              );
            },
          }),
          clientFailed,
        ]);

        if (claimed.size) throw new Error('Unfinished native invocation');

        // Final database work, without user callbacks under the stream lock.
        await Promise.race([
          publishFeed(client, scope.graphId, staged),
          clientFailed,
        ]);
        active = false;

        if (clientFailure) throw clientFailure;

        committing = true;
        const committed = await client.query('COMMIT');

        // PostgreSQL answers COMMIT with ROLLBACK for an already aborted transaction.
        if (committed.command === 'ROLLBACK') {
          rolledBack = true;
          throw new StorageUnavailable();
        }

        return result;
      } catch (error) {
        // Revoke retained handles before awaiting cleanup or releasing the client.
        active = false;
        await client.query('ROLLBACK').catch(() => {});

        if (
          committing &&
          !rolledBack &&
          !transactionRejected(error) &&
          !transactionRejected(clientFailure)
        )
          throw new NativeCommitUncertain();

        throw storageError(clientFailure ?? error);
      } finally {
        active = false;
        client.release(Boolean(clientFailure));
        client.removeListener('error', onError);
      }
    },
  };
}
