import type pg from 'pg';
import type {
  NativeStore,
  NativeScope,
  NativeRecord,
  NativeInvocation,
} from '@relate/runtime/storage';
import {
  NativeConflict,
  NativeCommitUncertain,
  StorageUnavailable,
} from '@relate/runtime/storage';
import { storageError, transactionRejected } from './errors.js';

export function createNativePostgresStore(pool: pg.Pool): NativeStore {
  function invocation(
    row: pg.QueryResultRow | undefined,
  ): NativeInvocation | undefined {
    return row?.receipt
      ? {
          actionDefinitionId: row.action_id,
          idempotencyKey: row.idempotency_key,
          actorId: row.actor_id ?? null,
          reads: row.reads ?? null,
          input: row.input,
          receipt: row.receipt,
        }
      : undefined;
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

    return row
      ? {
          objectDefinitionId: row.object_type,
          objectId: row.object_key,
          values: row.values,
          createdAt: Number(row.created_at),
        }
      : undefined;
  }

  return {
    async loadInvocation(scope, actionDefinitionId, idempotencyKey) {
      const result = await pool.query(
        `SELECT n.* FROM relate.native_invocations n JOIN relate.graphs g USING(graph_id) WHERE n.graph_id=$1 AND g.definition_revision=$2 AND n.action_id=$3 AND n.idempotency_key=$4`,
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
            async load(type, id) {
              check();

              return load(client, scope, type, id);
            },
            async insert(record) {
              check();
              await client.query(
                'INSERT INTO relate.native_objects(graph_id,object_type,object_key,values,created_at) VALUES ($1,$2,$3,$4::jsonb,$5)',
                [
                  scope.graphId,
                  record.objectDefinitionId,
                  record.objectId,
                  JSON.stringify(record.values),
                  record.createdAt,
                ],
              );
            },
            async claim(action, key) {
              check();
              const row = await client.query(
                'INSERT INTO relate.native_invocations(graph_id,action_id,idempotency_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING action_id',
                [scope.graphId, action, key],
              );

              if (!row.rowCount) {
                const existing = invocation(
                  (
                    await client.query(
                      'SELECT * FROM relate.native_invocations WHERE graph_id=$1 AND action_id=$2 AND idempotency_key=$3',
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
                    'SELECT * FROM relate.native_invocations WHERE graph_id=$1 AND action_id=$2 AND invocation_id=$3',
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
                'UPDATE relate.native_invocations SET invocation_id=$4,input=$5::jsonb,receipt=$6::jsonb,actor_id=$7,reads=$8::jsonb WHERE graph_id=$1 AND action_id=$2 AND idempotency_key=$3',
                [
                  scope.graphId,
                  invocation.actionDefinitionId,
                  invocation.idempotencyKey,
                  invocation.receipt.invocationId,
                  JSON.stringify(invocation.input),
                  JSON.stringify(invocation.receipt),
                  invocation.actorId,
                  JSON.stringify(invocation.reads),
                ],
              );
            },
          }),
          clientFailed,
        ]);

        if (claimed.size) throw new Error('Unfinished native invocation');

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
