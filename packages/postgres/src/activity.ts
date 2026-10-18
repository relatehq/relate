import type pg from 'pg';
import {
  ActivityError,
  encodeActivityCursor,
  feedReadOptions,
  operationReadOptions,
  validateFeedDraft,
  validateOperationDraft,
} from '@relate/runtime/storage';
import type {
  ActivityActor,
  ActivityStore,
  FeedDraft,
  FeedEntry,
  FeedFilter,
  Operation,
  OperationContext,
  OperationDraft,
  OperationFilter,
  OperationObject,
} from '@relate/runtime/storage';
import { storageError } from './errors.js';

type Client = Pick<pg.PoolClient, 'query'>;

/** PostgreSQL's Bind message can carry at most 65,535 parameters. */
const maxBindParameters = 65_535;

/** Insert ordered chunks on the caller's transaction; never commit between chunks. */
async function insertRows<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  client: Client,
  statement: string,
  rows: readonly (readonly unknown[])[],
  suffix = '',
): Promise<Row[]> {
  if (!rows.length) return [];

  const chunkSize = Math.floor(maxBindParameters / rows[0]!.length);
  const returned: Row[] = [];

  for (let start = 0; start < rows.length; start += chunkSize) {
    const values: unknown[] = [];
    const tuples = rows.slice(start, start + chunkSize).map((row) => {
      const offset = values.length;

      values.push(...row);

      return `(${row.map((_, index) => `$${offset + index + 1}`).join(',')})`;
    });
    const result = await client.query<Row>(
      `${statement} VALUES ${tuples.join(',')} ${suffix}`,
      values,
    );

    returned.push(...result.rows);
  }

  return returned;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resuming from this bound returns nothing: every row is newer.
const lowest = {
  recordedAt: new Date(0).toISOString(),
  id: '00000000-0000-0000-0000-000000000000',
};

const iso = (value: Date | string) => new Date(value).toISOString();

/** Only executionId, runtimeId and initiator; request fields have typed columns. */
function storedContext(context: OperationContext) {
  return {
    ...(context.executionId !== undefined
      ? { executionId: context.executionId }
      : {}),
    ...(context.runtimeId !== undefined
      ? { runtimeId: context.runtimeId }
      : {}),
    ...(context.initiator !== undefined
      ? { initiator: context.initiator }
      : {}),
  };
}

/**
 * Publish staged drafts as the final work of a transaction that already holds
 * its domain locks. The stream row lock serializes publication until COMMIT,
 * so no earlier position can become visible after a later one.
 */
export async function publishFeed(
  client: Client,
  graphId: string,
  drafts: readonly FeedDraft[],
): Promise<void> {
  if (!drafts.length) return;

  for (const draft of drafts) {
    validateFeedDraft(draft);

    if (draft.graphId !== graphId)
      throw new Error('Feed draft belongs to another graph');
  }

  const allocated = await client.query<{ position: string }>(
    'UPDATE relate.feed_streams SET position = position + $2 WHERE graph_id=$1 RETURNING position::text',
    [graphId, drafts.length],
  );

  if (!allocated.rowCount) throw new Error('Feed stream is not installed');

  const first =
    BigInt(allocated.rows[0]!.position) - BigInt(drafts.length) + 1n;
  const recordedAt = new Date().toISOString();
  const rows = drafts.map((draft, index) => {
    const change = 'object' in draft ? draft : undefined;
    const event = change
      ? undefined
      : (draft as Extract<FeedDraft, { actionDefinitionId: string }>);

    return [
      graphId,
      draft.id,
      draft.schemaVersion,
      String(first + BigInt(index)),
      draft.kind,
      change?.object.objectDefinitionId ?? null,
      change?.object.objectId ?? null,
      change ? [...change.changedPropertyIds] : null,
      change?.sourceDefinitionId ?? null,
      event?.actionDefinitionId ?? null,
      event?.failureCode ?? null,
      draft.invocationId ?? null,
      draft.operationId,
      change?.parentOperationId ?? null,
      draft.actor.kind,
      draft.actor.id,
      change?.triggeredBy?.kind ?? null,
      change?.triggeredBy?.id ?? null,
      draft.context.requestId,
      draft.context.transport,
      JSON.stringify(storedContext(draft.context)),
      draft.definitionRevision,
      draft.occurredAt,
      recordedAt,
    ];
  });

  await insertRows(
    client,
    'INSERT INTO relate.feed_entries(graph_id,id,schema_version,position,kind,object_type,object_key,changed_property_ids,source_definition_id,action_id,failure_code,invocation_id,operation_id,parent_operation_id,actor_kind,actor_id,triggered_by_kind,triggered_by_id,request_id,transport,context,definition_revision,occurred_at,recorded_at)',
    rows,
  );
}

function context(row: pg.QueryResultRow, stored: Record<string, unknown>) {
  return {
    requestId: row.request_id,
    transport: row.transport,
    ...stored,
  } as OperationContext;
}

function feedEntry(graphId: string, row: pg.QueryResultRow): FeedEntry {
  const base = {
    schemaVersion: row.schema_version,
    id: row.id,
    position: String(row.position),
    graphId,
    definitionRevision: row.definition_revision,
    operationId: row.operation_id,
    actor: { kind: row.actor_kind, id: row.actor_id },
    context: context(row, row.context ?? {}),
    occurredAt: iso(row.occurred_at),
    recordedAt: iso(row.recorded_at),
  };

  if (row.kind === 'invocation-succeeded' || row.kind === 'invocation-failed')
    return {
      ...base,
      kind: row.kind,
      actionDefinitionId: row.action_id,
      invocationId: row.invocation_id,
      ...(row.kind === 'invocation-failed'
        ? { failureCode: row.failure_code }
        : {}),
    } as FeedEntry;

  return {
    ...base,
    kind: row.kind,
    object: { objectDefinitionId: row.object_type, objectId: row.object_key },
    changedPropertyIds: row.changed_property_ids,
    ...(row.parent_operation_id
      ? { parentOperationId: row.parent_operation_id }
      : {}),
    ...(row.invocation_id !== null ? { invocationId: row.invocation_id } : {}),
    ...(row.triggered_by_kind !== null
      ? {
          triggeredBy: { kind: row.triggered_by_kind, id: row.triggered_by_id },
        }
      : {}),
    ...(row.source_definition_id !== null
      ? { sourceDefinitionId: row.source_definition_id }
      : {}),
  } as FeedEntry;
}

/** SQL conditions for one filter, matching the shared in-memory semantics. */
function conditions(values: unknown[]) {
  const add = (value: unknown) => `$${values.push(value)}`;
  const list: string[] = [];
  const common = (filter: FeedFilter | OperationFilter, started: string) => {
    if (filter.actor)
      list.push(
        `actor_kind=${add(filter.actor.kind)} AND actor_id=${add(filter.actor.id)}`,
      );

    if (filter.requestId !== undefined)
      list.push(`request_id=${add(filter.requestId)}`);

    if (filter.invocationId !== undefined)
      list.push(`invocation_id=${add(filter.invocationId)}`);

    if (filter.from !== undefined)
      list.push(`${started} >= ${add(filter.from)}::timestamptz`);

    if (filter.to !== undefined)
      list.push(`${started} <= ${add(filter.to)}::timestamptz`);

    if (filter.kinds) list.push(`kind = ANY(${add([...filter.kinds])})`);
  };

  return { add, list, common };
}

const asUuid = (value: string) => (uuid.test(value) ? value : undefined);

function feedConditions(filter: FeedFilter, values: unknown[]) {
  const { add, list, common } = conditions(values);

  common(filter, 'occurred_at');

  if (filter.objectDefinitionId !== undefined)
    list.push(`object_type=${add(filter.objectDefinitionId)}`);

  if (filter.object)
    list.push(
      `object_type=${add(filter.object.objectDefinitionId)} AND object_key=${add(filter.object.objectId)}`,
    );

  if (filter.operationId !== undefined) {
    const id = asUuid(filter.operationId);

    list.push(id ? `operation_id=${add(id)}::uuid` : 'FALSE');
  }

  if (filter.sourceDefinitionId !== undefined)
    list.push(`source_definition_id=${add(filter.sourceDefinitionId)}`);

  if (filter.actionDefinitionId !== undefined)
    list.push(`action_id=${add(filter.actionDefinitionId)}`);

  return list.map((condition) => ` AND (${condition})`).join('');
}

function operationConditions(filter: OperationFilter, values: unknown[]) {
  const { add, list, common } = conditions(values);

  common(filter, 'o.started_at');

  if (filter.outcomes)
    list.push(`o.outcome = ANY(${add([...filter.outcomes])})`);

  const role =
    filter.objectRole !== undefined
      ? ` AND l.role=${add(filter.objectRole)}`
      : '';
  const lineage = (match: string) =>
    `EXISTS (SELECT 1 FROM relate.operation_objects l WHERE l.graph_id=o.graph_id AND l.operation_id=o.id AND ${match}${role})`;

  if (filter.objectDefinitionId !== undefined) {
    const type = add(filter.objectDefinitionId);

    list.push(
      filter.objectRole === undefined
        ? `${lineage(`l.object_type=${type}`)} OR o.definition_id=${type}`
        : lineage(`l.object_type=${type}`),
    );
  }

  if (filter.object)
    list.push(
      lineage(
        `l.object_type=${add(filter.object.objectDefinitionId)} AND l.object_key=${add(filter.object.objectId)}`,
      ),
    );

  if (filter.operationId !== undefined) {
    const id = asUuid(filter.operationId);

    if (id) {
      const value = add(id);

      list.push(`o.id=${value}::uuid OR o.parent_operation_id=${value}::uuid`);
    } else list.push('FALSE');
  }

  return list.map((condition) => ` AND (${condition})`).join('');
}

function operation(
  graphId: string,
  row: pg.QueryResultRow,
  objects: OperationObject[],
): Operation {
  const outcome =
    row.outcome === 'failed' || row.outcome === 'rejected'
      ? { status: row.outcome, code: row.outcome_code }
      : { status: row.outcome };
  const target =
    row.target_type !== null
      ? {
          target: {
            objectDefinitionId: row.target_type,
            objectId: row.target_key,
          },
        }
      : {};
  const initiator: ActivityActor | undefined =
    row.initiator_kind !== null
      ? { kind: row.initiator_kind, id: row.initiator_id }
      : undefined;
  const base = {
    schemaVersion: row.schema_version,
    id: row.id,
    ...(row.parent_operation_id
      ? { parentOperationId: row.parent_operation_id }
      : {}),
    graphId,
    definitionRevision: row.definition_revision,
    actor: { kind: row.actor_kind, id: row.actor_id },
    context: context(row, {
      ...(row.execution_id !== null ? { executionId: row.execution_id } : {}),
      ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
      ...(initiator ? { initiator } : {}),
    }),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    durationMs: row.duration_ms,
    recordedAt: iso(row.recorded_at),
    objects,
    kind: row.kind,
    definitionId: row.definition_id,
    outcome,
    details: row.details,
  };

  // Reconstruct only the fields of this variant.
  switch (row.kind) {
    case 'get':
    case 'refresh':
    case 'adopt':
      return { ...base, ...target } as Operation;
    case 'invoke':
      return {
        ...base,
        ...(row.invocation_id !== null
          ? { invocationId: row.invocation_id }
          : {}),
        replayed: row.replayed,
      } as Operation;
    case 'receipt':
      return {
        ...base,
        ...(row.invocation_id !== null
          ? { invocationId: row.invocation_id }
          : {}),
      } as Operation;
    default:
      return base as Operation;
  }
}

async function snapshot<T>(
  pool: pg.Pool,
  read: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect().catch((error: unknown) => {
    throw new ActivityError('unavailable', { cause: error });
  });

  try {
    // One snapshot for the page, its high-water mark and its retention floor.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await read(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error instanceof ActivityError) throw error;

    throw new ActivityError('unavailable', { cause: storageError(error) });
  } finally {
    client.release();
  }
}

/**
 * Feed reads and operation browsing on the read pool; operation appends on a
 * dedicated single-connection pool so best-effort traffic never consumes the
 * connections committed writes need.
 */
export function createActivityPostgresStore(
  pool: pg.Pool,
  appendPool: pg.Pool,
): ActivityStore {
  return {
    atomicFeed: { sourceAcceptance: true, nativeTransactions: true },
    async appendOperations(graphId, drafts) {
      const seen = new Set<string>();
      const unique: OperationDraft[] = [];

      for (const draft of drafts) {
        validateOperationDraft(draft);

        if (draft.graphId !== graphId)
          throw new Error('Operation draft belongs to another graph');

        // First occurrence wins within a batch, as across batches.
        if (!seen.has(draft.id)) {
          seen.add(draft.id);
          unique.push(draft);
        }
      }

      if (!unique.length) return;

      const client = await appendPool.connect();

      try {
        await client.query('BEGIN');
        const recordedAt = new Date().toISOString();
        const rows = unique.map((draft) => {
          const target = 'target' in draft ? draft.target : undefined;

          return [
            graphId,
            draft.id,
            draft.schemaVersion,
            draft.parentOperationId ?? null,
            draft.kind,
            draft.actor.kind,
            draft.actor.id,
            draft.context.requestId,
            draft.context.transport,
            draft.context.executionId ?? null,
            draft.context.runtimeId ?? null,
            draft.context.initiator?.kind ?? null,
            draft.context.initiator?.id ?? null,
            draft.definitionRevision,
            draft.startedAt,
            draft.completedAt,
            draft.durationMs,
            recordedAt,
            draft.outcome.status,
            'code' in draft.outcome ? draft.outcome.code : null,
            draft.definitionId,
            target?.objectDefinitionId ?? null,
            target?.objectId ?? null,
            'invocationId' in draft ? (draft.invocationId ?? null) : null,
            'replayed' in draft ? draft.replayed : false,
            JSON.stringify(draft.details),
          ];
        });
        const inserted = await insertRows<{ id: string }>(
          client,
          'INSERT INTO relate.operations(graph_id,id,schema_version,parent_operation_id,kind,actor_kind,actor_id,request_id,transport,execution_id,runtime_id,initiator_kind,initiator_id,definition_revision,started_at,completed_at,duration_ms,recorded_at,outcome,outcome_code,definition_id,target_type,target_key,invocation_id,replayed,details)',
          rows,
          'ON CONFLICT (graph_id,id) DO NOTHING RETURNING id',
        );
        // Lineage only for operations this append newly inserted.
        const fresh = new Set(inserted.map((row) => row.id));
        const lineage: unknown[][] = [];

        for (const draft of unique) {
          if (!fresh.has(draft.id)) continue;

          draft.objects.forEach((object, ordinal) => {
            lineage.push([
              graphId,
              draft.id,
              ordinal,
              object.objectDefinitionId,
              object.objectId,
              object.role,
              [...object.returned],
              [...object.forbidden],
              [...object.unavailable],
            ]);
          });
        }

        await insertRows(
          client,
          'INSERT INTO relate.operation_objects(graph_id,operation_id,ordinal,object_type,object_key,role,returned,forbidden,unavailable)',
          lineage,
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw storageError(error);
      } finally {
        client.release();
      }
    },
    feed: {
      async read(graphId, options) {
        const { limit, filter, cursor } = feedReadOptions(options, graphId);

        return snapshot(pool, async (client) => {
          const stream = (
            await client.query<{
              stream_id: string;
              position: string;
              floor: string;
            }>(
              'SELECT stream_id, position::text, floor::text FROM relate.feed_streams WHERE graph_id=$1',
              [graphId],
            )
          ).rows[0];

          if (!stream) throw new ActivityError('unavailable');

          const highWater = BigInt(stream.position);
          let after = BigInt(stream.floor);

          if (cursor) {
            const position = BigInt(cursor.position);

            if (cursor.streamId !== stream.stream_id || position < after)
              throw new ActivityError('cursor-expired');

            if (position > highWater) throw new ActivityError('invalid-cursor');

            after = position;
          }

          const values: unknown[] = [graphId, String(after), String(highWater)];
          const where = feedConditions(filter, values);
          const result = await client.query(
            `SELECT * FROM relate.feed_entries
             WHERE graph_id=$1 AND position > $2::bigint AND position <= $3::bigint${where}
             ORDER BY position LIMIT ${limit + 1}`,
            values,
          );
          const hasMore = result.rows.length > limit;
          const page = result.rows
            .slice(0, limit)
            .map((row) => feedEntry(graphId, row));

          return {
            entries: page,
            nextCursor: encodeActivityCursor({
              method: 'feed',
              graphId,
              streamId: stream.stream_id,
              position: hasMore ? page.at(-1)!.position : String(highWater),
              filter,
            }),
            hasMore,
          };
        });
      },
    },
    operations: {
      async list(graphId, options) {
        const { limit, filter, cursor } = operationReadOptions(
          options,
          graphId,
        );

        if (cursor && !uuid.test(cursor.id))
          throw new ActivityError('invalid-cursor');

        return snapshot(pool, async (client) => {
          const values: unknown[] = [graphId];
          const bound = cursor
            ? ` AND (o.recorded_at, o.id) < ($${values.push(cursor.recordedAt)}::timestamptz, $${values.push(cursor.id)}::uuid)`
            : '';
          const where = operationConditions(filter, values);
          const rows = (
            await client.query(
              `SELECT o.* FROM relate.operations o
               WHERE o.graph_id=$1${bound}${where}
               ORDER BY o.recorded_at DESC, o.id DESC LIMIT ${limit + 1}`,
              values,
            )
          ).rows;
          const hasMore = rows.length > limit;
          const page = rows.slice(0, limit);
          const lineage = new Map<string, OperationObject[]>();

          if (page.length) {
            const objects = await client.query(
              `SELECT operation_id::text AS operation_id, object_type, object_key, role, returned, forbidden, unavailable
               FROM relate.operation_objects WHERE graph_id=$1 AND operation_id = ANY($2::uuid[])
               ORDER BY operation_id, ordinal`,
              [graphId, page.map((row) => row.id)],
            );

            for (const row of objects.rows) {
              const list = lineage.get(row.operation_id) ?? [];

              list.push({
                objectDefinitionId: row.object_type,
                objectId: row.object_key,
                role: row.role,
                returned: row.returned,
                forbidden: row.forbidden,
                unavailable: row.unavailable,
              });
              lineage.set(row.operation_id, list);
            }
          }

          let last: { recordedAt: string; id: string } | undefined;

          if (hasMore)
            last = {
              recordedAt: iso(page.at(-1)!.recorded_at),
              id: page.at(-1)!.id,
            };
          else {
            // The scanned range ends at the oldest row below the bound,
            // matching or not, so an exhausted sequence stays exhausted.
            const oldest = (
              await client.query(
                `SELECT o.recorded_at, o.id::text AS id FROM relate.operations o
                 WHERE o.graph_id=$1${bound} ORDER BY o.recorded_at ASC, o.id ASC LIMIT 1`,
                values.slice(0, cursor ? 3 : 1),
              )
            ).rows[0];

            if (oldest)
              last = { recordedAt: iso(oldest.recorded_at), id: oldest.id };
          }

          return {
            entries: page.map((row) =>
              operation(graphId, row, lineage.get(row.id) ?? []),
            ),
            nextCursor: encodeActivityCursor({
              method: 'operations',
              graphId,
              recordedAt:
                last?.recordedAt ?? cursor?.recordedAt ?? lowest.recordedAt,
              id: last?.id ?? cursor?.id ?? lowest.id,
              filter,
            }),
            hasMore,
          };
        });
      },
    },
  };
}
