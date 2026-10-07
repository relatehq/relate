import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { canonicalJson } from 'relate/model';
import {
  compareObservation,
  OrderingConflict,
  RetentionError,
} from '@relate/runtime/storage';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
  Observation,
} from '@relate/runtime/storage';
import { createNativePostgresStore } from './native.js';
import { storageError } from './errors.js';
import {
  initialMigration,
  nativeActionMigration,
  providerAccountMigration,
  receiptRecoveryMigration,
} from './migrations.js';

export interface PostgresOptions {
  connectionString: string;
}

export function createPostgresStore(
  options: PostgresOptions,
): ObservationStore & { migrate(): Promise<void>; close(): Promise<void> } {
  const poolOptions = {
    connectionString: options.connectionString,
    max: 5,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 3_000,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 5_000,
  };
  const pool = new pg.Pool(poolOptions);
  // Native transactions may refresh source evidence. Reserve a separate pool
  // so queued native locks cannot consume every source-observation connection.
  const nativePool = new pg.Pool({
    ...poolOptions,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    lock_timeout: 30_000,
    // Backstop for idle sessions; the runtime also bounds the entire native callback.
    idle_in_transaction_session_timeout: 60_000,
  });

  nativePool.on('error', () => {});

  // Idle client failures are handled by pg; callers receive operation failures.
  pool.on('error', () => {});
  const scopeValues = (scope: StorageScope) => [
    scope.graphId,
    scope.objectDefinitionId,
    scope.sourceDefinitionId,
    scope.connectionId,
    scope.partition,
    scope.providerAccountId,
  ];
  const rowObject = (row: {
    object_key: string;
    provider_key: string;
    observation: Observation;
  }): StoredObject => ({
    objectId: row.object_key,
    sourceRecordId: row.provider_key,
    observation: row.observation,
  });

  return {
    durability: 'persistent',
    native: createNativePostgresStore(nativePool),
    async migrate() {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('relate.schema', 0))",
        );
        await client.query('CREATE SCHEMA IF NOT EXISTS relate');
        await client.query(
          'CREATE TABLE IF NOT EXISTS relate.migrations (version integer PRIMARY KEY, checksum text NOT NULL)',
        );
        const migrations = [
          initialMigration,
          nativeActionMigration,
          providerAccountMigration,
          receiptRecoveryMigration,
        ];
        const existing = await client.query<{
          version: number;
          checksum: string;
        }>('SELECT version, checksum FROM relate.migrations ORDER BY version');

        for (const row of existing.rows) {
          const sql = migrations[row.version - 1];

          if (
            !sql ||
            row.checksum !== createHash('sha256').update(sql).digest('hex')
          )
            throw new Error('Relate migration checksum/version mismatch');
        }

        for (const [index, sql] of migrations.entries()) {
          const version = index + 1;

          if (existing.rows.some((row) => row.version === version)) continue;

          await client.query(sql);
          await client.query(
            'INSERT INTO relate.migrations(version, checksum) VALUES ($1,$2)',
            [version, createHash('sha256').update(sql).digest('hex')],
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async install(graphId, definitionRevision) {
      try {
        await pool.query(
          'INSERT INTO relate.graphs(graph_id,definition_revision) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [graphId, definitionRevision],
        );
        const result = await pool.query(
          'SELECT 1 FROM relate.graphs WHERE graph_id=$1 AND definition_revision=$2',
          [graphId, definitionRevision],
        );

        if (!result.rowCount)
          throw new Error(
            'Installed model differs; explicit migration required',
          );
      } catch (error) {
        throw storageError(error);
      }
    },
    async beginFetch() {
      const result = await pool.query<{ token: string }>(
        "SELECT nextval('relate.fetch_order')::text AS token",
      );

      return result.rows[0]!.token;
    },
    async load(scope, objectId) {
      const result = await pool.query(
        `SELECT o.object_key,o.provider_key,o.observation FROM relate.objects o
        JOIN relate.graphs g USING (graph_id)
        WHERE o.graph_id=$1 AND o.object_type=$2 AND o.source_id=$3 AND o.connection_id=$4 AND o.partition=$5 AND o.provider_account_id=$6 AND o.object_key=$7 AND g.definition_revision=$8`,
        [...scopeValues(scope), objectId, scope.definitionRevision],
      );

      return result.rows[0] ? rowObject(result.rows[0]) : undefined;
    },
    async resolve(scope, sourceRecordId) {
      const result = await pool.query(
        `SELECT o.object_key,o.provider_key,o.observation FROM relate.objects o
        JOIN relate.graphs g USING (graph_id)
        WHERE o.graph_id=$1 AND o.object_type=$2 AND o.source_id=$3 AND o.connection_id=$4 AND o.partition=$5 AND o.provider_account_id=$6 AND o.provider_key=$7 AND g.definition_revision=$8`,
        [...scopeValues(scope), sourceRecordId, scope.definitionRevision],
      );

      return result.rows[0] ? rowObject(result.rows[0]) : undefined;
    },
    async scan(scope, { after, limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid scan limit');

      const result = await pool.query(
        `SELECT o.object_key,o.provider_key,o.observation FROM relate.objects o
        JOIN relate.graphs g USING (graph_id)
        WHERE o.graph_id=$1 AND o.object_type=$2 AND o.source_id=$3 AND o.connection_id=$4 AND o.partition=$5 AND o.provider_account_id=$6
          AND g.definition_revision=$7 AND ($8::text IS NULL OR o.object_key COLLATE "C" > $8 COLLATE "C")
        ORDER BY o.object_key COLLATE "C" LIMIT $9`,
        [
          ...scopeValues(scope),
          scope.definitionRevision,
          after ?? null,
          limit + 1,
        ],
      );

      return {
        objects: result.rows.slice(0, limit).map(rowObject),
        hasMore: result.rows.length > limit,
      };
    },
    async accept(scope, input) {
      const client = await pool.connect().catch((error) => {
        throw new RetentionError('failed', { cause: error });
      });
      let committing = false;

      try {
        await client.query('BEGIN');
        const installed = await client.query(
          'SELECT 1 FROM relate.graphs WHERE graph_id=$1 AND definition_revision=$2 FOR SHARE',
          [scope.graphId, scope.definitionRevision],
        );

        if (!installed.rowCount) throw new Error('Model is not installed');

        // Same alias locks even before its first row exists. No I/O under this lock.
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [canonicalJson([...scopeValues(scope), input.sourceRecordId])],
        );
        const result = await client.query(
          `SELECT object_key,provider_key,observation FROM relate.objects
          WHERE graph_id=$1 AND object_type=$2 AND source_id=$3 AND connection_id=$4 AND partition=$5 AND provider_account_id=$6 AND provider_key=$7 FOR UPDATE`,
          [...scopeValues(scope), input.sourceRecordId],
        );
        const previous = result.rows[0] ? rowObject(result.rows[0]) : undefined;

        if (
          (!previous && !input.adopt) ||
          (input.objectId !== undefined &&
            previous?.objectId !== input.objectId)
        )
          throw new Error('Membership/alias mismatch');

        const acceptance = compareObservation(
          previous?.observation,
          input.observation,
        );
        let object = previous;

        if (acceptance === 'changed' || acceptance === 'unchanged') {
          object = {
            objectId: previous?.objectId ?? randomUUID(),
            sourceRecordId: input.sourceRecordId,
            observation: input.observation,
          };
          await client.query(
            `INSERT INTO relate.objects(graph_id,object_type,source_id,connection_id,partition,provider_account_id,object_key,provider_key,observation)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
            ON CONFLICT (graph_id,object_type,object_key) DO UPDATE SET observation=EXCLUDED.observation`,
            [
              ...scopeValues(scope),
              object.objectId,
              input.sourceRecordId,
              JSON.stringify(input.observation),
            ],
          );
          // Whole source record changes alone do not invent business value changes.
          const valueChanged =
            !previous ||
            previous.observation.state !== input.observation.state ||
            canonicalJson(previous.observation.values) !==
              canonicalJson(input.observation.values);

          if (valueChanged)
            await client.query(
              `INSERT INTO relate.value_changes(graph_id,object_type,object_key,origin,state,values,observed_at,fetch_token)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
              [
                scope.graphId,
                scope.objectDefinitionId,
                object.objectId,
                previous ? 'source-refresh' : 'adoption',
                input.observation.state,
                JSON.stringify(input.observation.values),
                new Date(input.observation.observedAt),
                input.observation.token,
              ],
            );
        }

        committing = true;
        await client.query('COMMIT');

        return { object: object!, acceptance };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});

        if (error instanceof OrderingConflict) throw error;

        throw new RetentionError(committing ? 'unconfirmed' : 'failed', {
          cause: error,
        });
      } finally {
        client.release();
      }
    },
    close: async () => {
      await Promise.all([pool.end(), nativePool.end()]);
    },
  };
}
