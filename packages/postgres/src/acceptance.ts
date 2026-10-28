import type pg from 'pg';
import { canonicalJson } from 'relate/model';
import type {
  AcceptAttribution,
  AcceptedChange,
  Observation,
  StorageScope,
  StoredObject,
} from '@relate/runtime/storage';

/** Physical identity columns of one source scope, in query parameter order. */
export function scopeValues(scope: StorageScope) {
  if (typeof scope.resourceId !== 'string' || !scope.resourceId.trim())
    throw new Error('Invalid source resource scope');

  // Empty text is only the physical encoding for an explicitly null application
  // identity. Never interpret missing or blank account evidence as that mode.
  if (
    scope.providerAccountId !== null &&
    (typeof scope.providerAccountId !== 'string' ||
      !scope.providerAccountId.trim())
  )
    throw new Error('Invalid source identity scope');

  return [
    scope.graphId,
    scope.objectDefinitionId,
    scope.sourceDefinitionId,
    scope.connectionId,
    scope.partition,
    scope.providerAccountId === null ? '' : scope.providerAccountId,
    scope.resourceId,
  ];
}

export function rowObject(row: {
  object_key: string;
  provider_key: string;
  observation: Observation;
}): StoredObject {
  return {
    objectId: row.object_key,
    sourceRecordId: row.provider_key,
    observation: row.observation,
  };
}

/**
 * Lock one source identity until the enclosing transaction ends and return its
 * committed member. The same alias locks even before its first row exists.
 * No I/O may happen under this lock except database work in the transaction.
 */
export async function lockIdentity(
  client: pg.PoolClient,
  scope: StorageScope,
  sourceRecordId: string,
): Promise<StoredObject | undefined> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    canonicalJson([...scopeValues(scope), sourceRecordId]),
  ]);
  const result = await client.query(
    `SELECT object_key,provider_key,observation FROM relate.objects
    WHERE graph_id=$1 AND object_type=$2 AND source_id=$3 AND connection_id=$4 AND resource_id=$7 AND partition=$5 AND provider_account_id=$6 AND identity_kind=CASE WHEN $6='' THEN 'application' ELSE 'provider' END AND provider_key=$8 FOR UPDATE`,
    [...scopeValues(scope), sourceRecordId],
  );

  return result.rows[0] ? rowObject(result.rows[0]) : undefined;
}

/**
 * Retain a winning observation under the identity lock. First membership
 * writes adoption provenance with the identity; later writes keep it. A
 * business transition also writes its version row.
 */
export async function retainObservation(
  client: pg.PoolClient,
  scope: StorageScope,
  previous: StoredObject | undefined,
  object: StoredObject,
  attribution: AcceptAttribution,
  change: AcceptedChange | undefined,
): Promise<void> {
  await client.query(
    `INSERT INTO relate.objects(graph_id,object_type,source_id,connection_id,partition,provider_account_id,resource_id,identity_kind,object_key,provider_key,observation,adopted_by_kind,adopted_by_id,adopted_at,adopted_invocation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,CASE WHEN $6='' THEN 'application' ELSE 'provider' END,$8,$9,$10::jsonb,$11,$12,$13,$14)
    ON CONFLICT (graph_id,object_type,object_key) DO UPDATE SET observation=EXCLUDED.observation`,
    [
      ...scopeValues(scope),
      object.objectId,
      object.sourceRecordId,
      JSON.stringify(object.observation),
      attribution.actor.kind,
      attribution.actor.id,
      new Date(attribution.occurredAt),
      attribution.invocationId ?? null,
    ],
  );

  if (change)
    await client.query(
      `INSERT INTO relate.object_versions(graph_id,object_type,object_key,origin,state,values,observed_at,fetch_token,change_id)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [
        scope.graphId,
        scope.objectDefinitionId,
        object.objectId,
        previous ? 'source-refresh' : 'adoption',
        object.observation.state,
        JSON.stringify(object.observation.values),
        new Date(object.observation.observedAt),
        object.observation.token,
        change.id,
      ],
    );
}
