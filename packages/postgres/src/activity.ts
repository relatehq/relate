import type pg from 'pg';
import type { ActivityQueryFilter } from '@relate/runtime/storage';
import type { ActivityStore, FeedDraft } from 'relate/storage';
import type { FeedEntry, Operation, OperationContext } from '@relate/protocol';
import {
  activityPage,
  prepareActivityRead,
  activityId,
  validateBatch,
} from '@relate/runtime/storage';

/** Final transaction work: the row lock remains held until the caller commits. */
export async function publishFeed(
  client: pg.PoolClient,
  graphId: string,
  drafts: readonly FeedDraft[],
) {
  if (!drafts.length) return;

  validateBatch(graphId, drafts);
  await client.query(
    'INSERT INTO relate.feed_streams(graph_id,stream_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [graphId, activityId()],
  );
  const counter = await client.query(
    'UPDATE relate.feed_streams SET position=position+$2 WHERE graph_id=$1 RETURNING position',
    [graphId, drafts.length],
  );
  const first = BigInt(counter.rows[0].position) - BigInt(drafts.length) + 1n;

  for (const [index, draft] of drafts.entries()) {
    const change = 'object' in draft ? draft : undefined;
    const invocation = 'actionDefinitionId' in draft ? draft : undefined;
    const { requestId, transport, ...context } = draft.context;

    await client.query(
      `INSERT INTO relate.feed_entries(graph_id,id,schema_version,position,kind,object_type,object_key,changed_property_ids,source_definition_id,action_id,failure_code,invocation_id,operation_id,parent_operation_id,actor_kind,actor_id,triggered_by_kind,triggered_by_id,request_id,transport,context,definition_revision,occurred_at,recorded_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,date_trunc('milliseconds',clock_timestamp()))`,
      [
        graphId,
        draft.id,
        draft.schemaVersion,
        String(first + BigInt(index)),
        draft.kind,
        change?.object.objectDefinitionId ?? null,
        change?.object.objectId ?? null,
        change?.changedPropertyIds ?? null,
        change?.sourceDefinitionId ?? null,
        invocation?.actionDefinitionId ?? null,
        invocation?.failureCode ?? null,
        draft.invocationId ?? null,
        draft.operationId,
        change?.parentOperationId ?? null,
        draft.actor.kind,
        draft.actor.id,
        change?.triggeredBy?.kind ?? null,
        change?.triggeredBy?.id ?? null,
        requestId,
        transport,
        JSON.stringify(context),
        draft.definitionRevision,
        draft.occurredAt,
      ],
    );
  }
}

const iso = (value: Date | string) => new Date(value).toISOString();

function context(row: pg.QueryResultRow): OperationContext {
  return {
    requestId: row.request_id,
    transport: row.transport,
    ...row.context,
  };
}

function feed(row: pg.QueryResultRow): FeedEntry {
  const common = {
    schemaVersion: row.schema_version,
    id: row.id,
    position: String(row.position),
    graphId: row.graph_id,
    definitionRevision: row.definition_revision,
    kind: row.kind,
    operationId: row.operation_id,
    actor: { kind: row.actor_kind, id: row.actor_id },
    context: context(row),
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
  };

  return row.object_key !== null
    ? ({
        ...common,
        object: {
          objectDefinitionId: row.object_type,
          objectId: row.object_key,
        },
        changedPropertyIds: row.changed_property_ids,
        ...(row.source_definition_id
          ? { sourceDefinitionId: row.source_definition_id }
          : {}),
        ...(row.parent_operation_id
          ? { parentOperationId: row.parent_operation_id }
          : {}),
        ...(row.triggered_by_id
          ? {
              triggeredBy: {
                kind: row.triggered_by_kind,
                id: row.triggered_by_id,
              },
            }
          : {}),
      } as FeedEntry)
    : ({
        ...common,
        actionDefinitionId: row.action_id,
        ...(row.failure_code !== null ? { failureCode: row.failure_code } : {}),
      } as FeedEntry);
}

function operation(row: pg.QueryResultRow): Operation {
  return {
    schemaVersion: row.schema_version,
    id: row.id,
    graphId: row.graph_id,
    definitionRevision: row.definition_revision,
    kind: row.kind,
    actor: { kind: row.actor_kind, id: row.actor_id },
    context: context({
      ...row,
      context: {
        ...(row.execution_id ? { executionId: row.execution_id } : {}),
        ...(row.runtime_id ? { runtimeId: row.runtime_id } : {}),
        ...(row.initiator_id
          ? { initiator: { kind: row.initiator_kind, id: row.initiator_id } }
          : {}),
      },
    }),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    durationMs: row.duration_ms,
    recordedAt: iso(row.recorded_at),
    outcome: {
      status: row.outcome,
      ...(row.outcome_code !== null ? { code: row.outcome_code } : {}),
    },
    definitionId: row.definition_id,
    details: row.details,
    objects: row.objects ?? [],
    ...(row.parent_operation_id
      ? { parentOperationId: row.parent_operation_id }
      : {}),
    ...(row.target_key
      ? {
          target: {
            objectDefinitionId: row.target_type,
            objectId: row.target_key,
          },
        }
      : {}),
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.kind === 'invoke' ? { replayed: row.replayed } : {}),
  } as Operation;
}

function filterSql(
  filter: ActivityQueryFilter,
  method: 'feed' | 'operations',
  values: unknown[],
): string {
  const clauses: string[] = [],
    bind = (v: unknown) => {
      values.push(v);

      return `$${values.length}`;
    };

  if (filter.actor) {
    clauses.push(
      `o.actor_kind=${bind(filter.actor.kind)}`,
      `o.actor_id=${bind(filter.actor.id)}`,
    );
  }

  for (const [field, column] of [
    ['requestId', 'request_id'],
    ['invocationId', 'invocation_id'],
    ['operationId', method === 'feed' ? 'operation_id' : 'id'],
    ['sourceDefinitionId', 'source_definition_id'],
    ['actionDefinitionId', 'action_id'],
  ] as const)
    if (filter[field]) clauses.push(`o.${column}=${bind(filter[field])}`);

  if (filter.kinds) clauses.push(`o.kind=ANY(${bind(filter.kinds)}::text[])`);

  if (filter.outcomes)
    clauses.push(`o.outcome=ANY(${bind(filter.outcomes)}::text[])`);

  if (filter.from)
    clauses.push(
      `o.${method === 'feed' ? 'occurred_at' : 'started_at'}>=${bind(filter.from)}::timestamptz`,
    );

  if (filter.to)
    clauses.push(
      `o.${method === 'feed' ? 'occurred_at' : 'started_at'}<=${bind(filter.to)}::timestamptz`,
    );

  if (filter.object || filter.objectDefinitionId || filter.objectRole) {
    const type = bind(
        filter.object?.objectDefinitionId ?? filter.objectDefinitionId,
      ),
      id = filter.object ? bind(filter.object.objectId) : undefined;

    if (method === 'feed')
      clauses.push(
        `o.object_type=${type}${id ? ` AND o.object_key=${id}` : ''}`,
      );
    else {
      const refs = `EXISTS (SELECT 1 FROM relate.operation_objects x WHERE x.graph_id=o.graph_id AND x.operation_id=o.id AND x.object_type=${type}${id ? ` AND x.object_key=${id}` : ''}${filter.objectRole ? ` AND x.role=${bind(filter.objectRole)}` : ''})`;

      clauses.push(
        !filter.object && !filter.objectRole
          ? `(o.definition_id=${type} OR ${refs})`
          : refs,
      );
    }
  }

  return clauses.length ? ' AND ' + clauses.join(' AND ') : '';
}

export function createPostgresActivity(
  pool: pg.Pool,
  operationPool: pg.Pool,
): ActivityStore {
  return {
    async status(graphId) {
      const result = await pool.query(
        'SELECT 1 FROM relate.feed_streams WHERE graph_id=$1',
        [graphId],
      );

      if (!result.rowCount) throw new Error('Missing activity stream');

      return { state: 'available', durability: 'persistent' };
    },
    async appendOperations(graphId, drafts) {
      validateBatch(graphId, drafts);
      const client = await operationPool.connect();

      try {
        await client.query('BEGIN');

        for (const row of drafts) {
          const target = 'target' in row ? row.target : undefined;
          const result = await client.query(
            `INSERT INTO relate.operations(graph_id,id,schema_version,parent_operation_id,kind,actor_kind,actor_id,request_id,transport,execution_id,runtime_id,initiator_kind,initiator_id,definition_revision,started_at,completed_at,duration_ms,recorded_at,outcome,outcome_code,definition_id,target_type,target_key,invocation_id,replayed,details)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,date_trunc('milliseconds',clock_timestamp()),$18,$19,$20,$21,$22,$23,$24,$25::jsonb) ON CONFLICT (graph_id,id) DO NOTHING RETURNING id`,
            [
              graphId,
              row.id,
              row.schemaVersion,
              row.parentOperationId ?? null,
              row.kind,
              row.actor.kind,
              row.actor.id,
              row.context.requestId,
              row.context.transport,
              row.context.executionId ?? null,
              row.context.runtimeId ?? null,
              row.context.initiator?.kind ?? null,
              row.context.initiator?.id ?? null,
              row.definitionRevision,
              row.startedAt,
              row.completedAt,
              row.durationMs,
              row.outcome.status,
              'code' in row.outcome ? row.outcome.code : null,
              row.definitionId,
              target?.objectDefinitionId ?? null,
              target?.objectId ?? null,
              'invocationId' in row ? (row.invocationId ?? null) : null,
              'replayed' in row ? row.replayed : false,
              JSON.stringify(row.details),
            ],
          );

          if (!result.rowCount) continue;

          for (const [ordinal, object] of row.objects.entries())
            await client.query(
              'INSERT INTO relate.operation_objects(graph_id,operation_id,ordinal,object_type,object_key,role,returned,forbidden,unavailable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                graphId,
                row.id,
                ordinal,
                object.objectDefinitionId,
                object.objectId,
                object.role,
                object.returned,
                object.forbidden,
                object.unavailable,
              ],
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
    feed: {
      async read(graphId, options) {
        const client = await pool.connect();

        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const stream = (
            await client.query(
              'SELECT stream_id,position,floor FROM relate.feed_streams WHERE graph_id=$1',
              [graphId],
            )
          ).rows[0];

          if (!stream) throw new Error('Missing activity stream');

          const snapshot = {
            streamId: stream.stream_id,
            position: stream.position,
            floor: stream.floor,
          };
          const { cursor, limit } = prepareActivityRead(
            graphId,
            'feed',
            snapshot,
            options,
          );
          const values: unknown[] = [graphId, cursor.after, stream.position];
          const where = filterSql(cursor.filter, 'feed', values);

          values.push(limit + 1);
          const rows = await client.query(
            `SELECT o.* FROM relate.feed_entries o WHERE graph_id=$1 AND position>$2::bigint AND position<=$3::bigint${where} ORDER BY position LIMIT $${values.length}`,
            values,
          );
          const result = activityPage(
            graphId,
            'feed',
            snapshot,
            rows.rows.map(feed),
            options,
          );

          await client.query('COMMIT');

          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    },
    operations: {
      async list(graphId, options) {
        const client = await pool.connect();

        try {
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const stream = (
            await client.query(
              'SELECT stream_id,position,floor FROM relate.feed_streams WHERE graph_id=$1',
              [graphId],
            )
          ).rows[0];

          if (!stream) throw new Error('Missing activity stream');

          const latest = (
            await client.query(
              'SELECT recorded_at,id FROM relate.operations WHERE graph_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1',
              [graphId],
            )
          ).rows[0];
          const snapshot = {
            streamId: stream.stream_id,
            position: stream.position,
            floor: stream.floor,
            operationsUpper: latest
              ? `${iso(latest.recorded_at)}/${latest.id}`
              : '',
          };
          const { cursor, limit } = prepareActivityRead(
            graphId,
            'operations',
            snapshot,
            options,
          );
          const values: unknown[] = [graphId];
          let where = filterSql(cursor.filter, 'operations', values);

          for (const [bound, operator] of [
            [cursor.upper, '<='],
            [cursor.after, '<'],
          ] as const)
            if (bound) {
              const [time, id] = bound.split('/');

              values.push(time, id);
              where += ` AND (o.recorded_at,o.id) ${operator} ($${values.length - 1}::timestamptz,$${values.length}::uuid)`;
            }

          if (!cursor.upper) where += ' AND false';

          values.push(limit + 1);
          const rows = await client.query(
            `SELECT o.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('objectDefinitionId',x.object_type,'objectId',x.object_key,'role',x.role,'returned',x.returned,'forbidden',x.forbidden,'unavailable',x.unavailable) ORDER BY ordinal) FROM relate.operation_objects x WHERE x.graph_id=o.graph_id AND x.operation_id=o.id),'[]'::jsonb) AS objects FROM relate.operations o WHERE graph_id=$1${where} ORDER BY recorded_at DESC,id DESC LIMIT $${values.length}`,
            values,
          );
          const result = activityPage(
            graphId,
            'operations',
            snapshot,
            rows.rows.map(operation),
            options,
          );

          await client.query('COMMIT');

          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
    },
  };
}
