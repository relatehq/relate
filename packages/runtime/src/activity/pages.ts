import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { ActivityError } from '@relate/protocol';
import type {
  ActivityFilter,
  ActivityReadOptions,
  ActivityPage,
  FeedEntry,
  Operation,
  FeedFilter,
  OperationFilter,
} from '@relate/protocol';

export type ActivityQueryFilter = FeedFilter & OperationFilter;

type Filter = ActivityQueryFilter;

type Cursor = {
  graphId: string;
  streamId: string;
  method: string;
  filter: Filter;
  after: string;
  upper?: string;
};

export interface ActivitySnapshot {
  streamId: string;
  position: string;
  floor: string;
  operationsFloor?: string;
  operationsUpper?: string;
}

function key(stream: string) {
  return createHash('sha256').update(stream).digest();
}

function encode(cursor: Cursor) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(cursor.streamId), iv);

  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(cursor)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64url');
}

function decode(token: string, stream: string): Cursor {
  try {
    if (typeof token !== 'string' || token.length > 16000) throw new Error();

    const bytes = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(stream),
      bytes.subarray(0, 12),
    );

    decipher.setAuthTag(bytes.subarray(-16));

    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString(),
    ) as Cursor;
  } catch {
    throw new ActivityError('invalid-cursor');
  }
}

const common = [
  'actor',
  'objectDefinitionId',
  'object',
  'invocationId',
  'operationId',
  'requestId',
  'from',
  'to',
];

export function validateFilter(filter: Filter, method: string) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter))
    throw new ActivityError('invalid-request');

  for (const name of ['actor', 'object'] as const)
    if (
      filter[name] !== undefined &&
      (!filter[name] ||
        typeof filter[name] !== 'object' ||
        Array.isArray(filter[name]))
    )
      throw new ActivityError('invalid-request');

  for (const name of ['kinds', 'outcomes'] as const)
    if (filter[name] !== undefined && !Array.isArray(filter[name]))
      throw new ActivityError('invalid-request');

  const allowed = [
    ...common,
    ...(method === 'feed'
      ? ['kinds', 'sourceDefinitionId', 'actionDefinitionId']
      : ['kinds', 'objectRole', 'outcomes']),
  ];

  if (Object.keys(filter).some((k) => !allowed.includes(k)))
    throw new ActivityError('invalid-request');

  if (
    filter.object &&
    (typeof filter.object.objectId !== 'string' ||
      !filter.object.objectId ||
      typeof filter.object.objectDefinitionId !== 'string' ||
      !filter.object.objectDefinitionId ||
      Object.keys(filter.object).some(
        (k) => !['objectId', 'objectDefinitionId'].includes(k),
      ))
  )
    throw new ActivityError('invalid-request');

  if (
    (filter.object &&
      filter.objectDefinitionId &&
      filter.object.objectDefinitionId !== filter.objectDefinitionId) ||
    (filter.objectRole && !filter.object && !filter.objectDefinitionId)
  )
    throw new ActivityError('invalid-request');

  if (
    filter.actor &&
    (!['principal', 'system', 'source'].includes(filter.actor.kind) ||
      typeof filter.actor.id !== 'string' ||
      !filter.actor.id ||
      Object.keys(filter.actor).some((k) => !['kind', 'id'].includes(k)))
  )
    throw new ActivityError('invalid-request');

  for (const name of [
    'objectDefinitionId',
    'invocationId',
    'operationId',
    'requestId',
    'sourceDefinitionId',
    'actionDefinitionId',
  ] as const)
    if (
      filter[name] !== undefined &&
      (typeof filter[name] !== 'string' || !filter[name])
    )
      throw new ActivityError('invalid-request');

  for (const name of ['from', 'to'] as const)
    if (
      filter[name] !== undefined &&
      (typeof filter[name] !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          filter[name]!,
        ) ||
        !Number.isFinite(Date.parse(filter[name]!)))
    )
      throw new ActivityError('invalid-request');

  if (filter.from && filter.to && filter.from > filter.to)
    throw new ActivityError('invalid-request');

  const choices =
    method === 'feed'
      ? [
          'created',
          'adopted',
          'updated',
          'deleted',
          'restored',
          'invocation-succeeded',
          'invocation-failed',
        ]
      : ['get', 'query', 'traverse', 'invoke', 'receipt', 'adopt', 'refresh'];

  if (
    filter.kinds &&
    (!Array.isArray(filter.kinds) ||
      filter.kinds.some((k) => !choices.includes(k)))
  )
    throw new ActivityError('invalid-request');

  if (
    filter.outcomes &&
    (!Array.isArray(filter.outcomes) ||
      filter.outcomes.some(
        (k) =>
          ![
            'ok',
            'not-found',
            'succeeded',
            'failed',
            'rejected',
            'uncertain',
          ].includes(k),
      ))
  )
    throw new ActivityError('invalid-request');

  if (
    filter.objectRole !== undefined &&
    !['target', 'returned', 'traversal-origin'].includes(filter.objectRole)
  )
    throw new ActivityError('invalid-request');
}

export function matchesActivity(row: FeedEntry | Operation, filter: Filter) {
  if (
    filter.actor &&
    (row.actor.kind !== filter.actor.kind || row.actor.id !== filter.actor.id)
  )
    return false;

  if (
    (filter.requestId && row.context.requestId !== filter.requestId) ||
    (filter.invocationId &&
      (!('invocationId' in row) || row.invocationId !== filter.invocationId)) ||
    (filter.operationId &&
      ('operationId' in row ? row.operationId : row.id) !== filter.operationId)
  )
    return false;

  const at = 'startedAt' in row ? row.startedAt : row.occurredAt;

  if (
    (filter.from && Date.parse(at) < Date.parse(filter.from)) ||
    (filter.to && Date.parse(at) > Date.parse(filter.to))
  )
    return false;

  if (filter.kinds && !(filter.kinds as readonly string[]).includes(row.kind))
    return false;

  if (
    (filter.sourceDefinitionId &&
      (!('sourceDefinitionId' in row) ||
        row.sourceDefinitionId !== filter.sourceDefinitionId)) ||
    (filter.actionDefinitionId &&
      (!('actionDefinitionId' in row) ||
        row.actionDefinitionId !== filter.actionDefinitionId))
  )
    return false;

  if (
    filter.outcomes &&
    (!('outcome' in row) || !filter.outcomes.includes(row.outcome.status))
  )
    return false;

  const refs =
    'objects' in row ? row.objects : 'object' in row ? [row.object] : [];
  const refMatches = refs.some(
    (ref) =>
      (!filter.object ||
        (ref.objectId === filter.object.objectId &&
          ref.objectDefinitionId === filter.object.objectDefinitionId)) &&
      (!filter.objectDefinitionId ||
        ref.objectDefinitionId === filter.objectDefinitionId) &&
      (!filter.objectRole || ('role' in ref && ref.role === filter.objectRole)),
  );

  if (
    (filter.object || filter.objectDefinitionId || filter.objectRole) &&
    !refMatches &&
    !(
      filter.objectDefinitionId &&
      !filter.object &&
      !filter.objectRole &&
      'definitionId' in row &&
      row.definitionId === filter.objectDefinitionId
    )
  )
    return false;

  return true;
}

export const operationPosition = (row: Operation) =>
  `${row.recordedAt}/${row.id}`;

export function activityPage<T extends FeedEntry | Operation>(
  graphId: string,
  method: 'feed' | 'operations',
  snapshot: ActivitySnapshot,
  rows: readonly T[],
  options: ActivityReadOptions<ActivityFilter> = {},
): ActivityPage<T> {
  const { cursor, limit } = prepareActivityRead(
    graphId,
    method,
    {
      ...snapshot,
      operationsUpper:
        snapshot.operationsUpper ??
        rows
          .filter((r) => 'objects' in r)
          .map((r) => operationPosition(r as Operation))
          .sort()
          .at(-1) ??
        '',
    },
    options,
  );
  const candidates = rows
    .filter((row) =>
      method === 'feed'
        ? BigInt((row as FeedEntry).position) > BigInt(cursor.after) &&
          BigInt((row as FeedEntry).position) <= BigInt(snapshot.position)
        : operationPosition(row as Operation) <= cursor.upper! &&
          (!cursor.after || operationPosition(row as Operation) < cursor.after),
    )
    .sort((a, b) =>
      method === 'feed'
        ? BigInt((a as FeedEntry).position) < BigInt((b as FeedEntry).position)
          ? -1
          : 1
        : operationPosition(a as Operation) > operationPosition(b as Operation)
          ? -1
          : 1,
    );
  const matches = candidates.filter((row) =>
    matchesActivity(row, cursor.filter),
  );
  const entries = matches.slice(0, limit),
    hasMore = matches.length > limit;
  const last = entries.at(-1);
  const after =
    method === 'feed'
      ? hasMore
        ? (last as FeedEntry).position
        : snapshot.position
      : hasMore
        ? operationPosition(last as Operation)
        : candidates.length
          ? operationPosition(candidates.at(-1) as Operation)
          : cursor.after;
  const nextCursor = `${createHash('sha256').update(`${graphId}/${method}`).digest('hex').slice(0, 16)}.${createHash('sha256').update(snapshot.streamId).digest('hex').slice(0, 16)}.${encode({ ...cursor, after })}`;

  return { entries: structuredClone(entries), hasMore, nextCursor };
}

export function prepareActivityRead(
  graphId: string,
  method: 'feed' | 'operations',
  snapshot: ActivitySnapshot,
  options: ActivityReadOptions<ActivityFilter> = {},
) {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (k) => !['filter', 'cursor', 'limit'].includes(k),
    ) ||
    ('cursor' in options && 'filter' in options)
  )
    throw new ActivityError('invalid-request');

  const limit = options.limit ?? 50;

  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new ActivityError('invalid-request');

  let cursor: Cursor;

  if ('cursor' in options) {
    if (
      typeof options.cursor !== 'string' ||
      options.cursor.length > 16000 ||
      options.cursor.split('.').length !== 3
    )
      throw new ActivityError('invalid-cursor');

    // The stream prefix permits explicit expiry after reset without exposing its key.
    const [binding, identity, token] = options.cursor!.split('.');

    if (
      binding !==
      createHash('sha256')
        .update(`${graphId}/${method}`)
        .digest('hex')
        .slice(0, 16)
    )
      throw new ActivityError('invalid-cursor');

    if (
      identity !==
      createHash('sha256').update(snapshot.streamId).digest('hex').slice(0, 16)
    ) {
      if (!/^[0-9a-f]{16}$/.test(identity ?? '') || !token)
        throw new ActivityError('invalid-cursor');

      throw new ActivityError('cursor-expired');
    }

    cursor = decode(token!, snapshot.streamId);

    if (cursor.graphId !== graphId || cursor.method !== method)
      throw new ActivityError('invalid-cursor');
  } else {
    let filter: Filter;

    try {
      filter = structuredClone(options.filter ?? {});
    } catch {
      throw new ActivityError('invalid-request');
    }

    validateFilter(filter, method);
    cursor = {
      graphId,
      streamId: snapshot.streamId,
      method,
      filter,
      after: method === 'feed' ? snapshot.floor : '',
      ...(method === 'operations'
        ? { upper: snapshot.operationsUpper ?? '' }
        : {}),
    };
  }

  if (
    (method === 'feed' && BigInt(cursor.after) < BigInt(snapshot.floor)) ||
    (method === 'operations' &&
      snapshot.operationsFloor &&
      cursor.after &&
      cursor.after <= snapshot.operationsFloor)
  )
    throw new ActivityError('cursor-expired');

  return { cursor, limit };
}
