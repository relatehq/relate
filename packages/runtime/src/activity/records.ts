import { randomBytes } from 'node:crypto';
import type {
  FeedDraft,
  OperationDraft,
  AcceptanceProvenance,
  StorageScope,
  Observation,
} from 'relate/storage';
import type { Change, OperationContext } from '@relate/protocol';
import { describeAcceptedChange } from '../observations/changes.js';

export function activityId(): string {
  const bytes = randomBytes(16);

  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6]! & 15) | 112;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const activityBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

export const activityLimits = {
  maxEntries: 10_000,
  maxBytes: 16 * 1024 * 1024,
  rowBytes: 256 * 1024,
  batchBytes: 4 * 1024 * 1024,
};

export type ActivityLimits = Partial<typeof activityLimits>;

const kinds = [
  'created',
  'adopted',
  'updated',
  'deleted',
  'restored',
  'invocation-succeeded',
  'invocation-failed',
];
const operationKinds = [
  'get',
  'query',
  'traverse',
  'invoke',
  'receipt',
  'adopt',
  'refresh',
];
const nonempty = (s: unknown) => typeof s === 'string' && s.length > 0;

function keys(value: object, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k)))
    throw new Error('Invalid activity fields');
}

function actor(value: { kind: string; id: string }) {
  if (
    !value ||
    !['principal', 'system', 'source'].includes(value.kind) ||
    !nonempty(value.id)
  )
    throw new Error('Invalid activity actor');

  keys(value, ['kind', 'id']);
}

export function validateContext(context: OperationContext) {
  if (
    !context ||
    !nonempty(context.requestId) ||
    !['embedded', 'http', 'mcp'].includes(context.transport)
  )
    throw new Error('Invalid activity context');

  keys(context, [
    'requestId',
    'transport',
    'executionId',
    'runtimeId',
    'initiator',
  ]);

  if (context.initiator) actor(context.initiator);

  for (const field of ['executionId', 'runtimeId'] as const)
    if (context[field] !== undefined && !nonempty(context[field]))
      throw new Error('Invalid activity context');
}

export function validateActivity(
  row: FeedDraft | OperationDraft,
  graphId: string,
) {
  if (
    !row ||
    row.schemaVersion !== 1 ||
    row.graphId !== graphId ||
    !nonempty(row.definitionRevision) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      row.id,
    )
  )
    throw new Error('Invalid activity identity');

  actor(row.actor);
  validateContext(row.context);
  const common = [
    'id',
    'schemaVersion',
    'graphId',
    'definitionRevision',
    'actor',
    'context',
  ];
  const date = (s: string) => {
    if (typeof s !== 'string' || !Number.isFinite(Date.parse(s)))
      throw new Error('Invalid activity time');
  };
  const ref = (v: { objectDefinitionId: string; objectId: string }) => {
    if (!v || !nonempty(v.objectDefinitionId) || !nonempty(v.objectId))
      throw new Error('Invalid activity reference');
  };

  if ('operationId' in row) {
    keys(row, [
      ...common,
      'kind',
      'operationId',
      'parentOperationId',
      'invocationId',
      'occurredAt',
      ...('object' in row
        ? ['object', 'changedPropertyIds', 'sourceDefinitionId', 'triggeredBy']
        : ['actionDefinitionId', 'failureCode']),
    ]);
    date(row.occurredAt);

    if (!kinds.includes(row.kind) || !nonempty(row.operationId))
      throw new Error('Invalid feed kind');

    if ('object' in row) {
      if (
        !['created', 'adopted', 'updated', 'deleted', 'restored'].includes(
          row.kind,
        )
      )
        throw new Error('Invalid change kind');

      ref(row.object);
      keys(row.object, ['objectDefinitionId', 'objectId']);

      if (
        !Array.isArray(row.changedPropertyIds) ||
        row.changedPropertyIds.some((id) => !nonempty(id))
      )
        throw new Error('Invalid property IDs');

      if (
        ['deleted', 'restored'].includes(row.kind) &&
        row.changedPropertyIds.length
      )
        throw new Error('Invalid transition properties');

      if (
        (row.kind === 'created' && row.sourceDefinitionId) ||
        (row.kind === 'adopted' && !row.sourceDefinitionId)
      )
        throw new Error('Invalid change source');

      if (row.sourceDefinitionId) {
        if (row.invocationId) throw new Error('Source invocation attribution');

        if (row.kind === 'adopted') {
          if (row.actor.kind === 'source' || row.triggeredBy)
            throw new Error('Invalid adoption actor');
        } else {
          if (
            row.actor.kind !== 'source' ||
            row.actor.id !== row.sourceDefinitionId ||
            !row.triggeredBy ||
            row.triggeredBy.kind === 'source'
          )
            throw new Error('Invalid refresh actor');

          actor(row.triggeredBy);
        }
      } else if (
        !row.invocationId ||
        row.actor.kind === 'source' ||
        row.triggeredBy
      )
        throw new Error('Invalid native attribution');
    } else if (
      !['invocation-succeeded', 'invocation-failed'].includes(row.kind) ||
      !nonempty(row.invocationId) ||
      !nonempty(row.actionDefinitionId) ||
      row.actor.kind === 'source' ||
      (row.kind === 'invocation-failed'
        ? !nonempty(row.failureCode)
        : row.failureCode !== undefined)
    )
      throw new Error('Invalid invocation event');
  } else {
    keys(row, [
      ...common,
      'parentOperationId',
      'kind',
      'startedAt',
      'completedAt',
      'durationMs',
      'objects',
      'outcome',
      'definitionId',
      'details',
      ...(['get', 'adopt', 'refresh'].includes(row.kind) ? ['target'] : []),
      ...(['invoke', 'receipt'].includes(row.kind) ? ['invocationId'] : []),
      ...(row.kind === 'invoke' ? ['replayed'] : []),
    ]);
    date(row.startedAt);
    date(row.completedAt);

    if (
      !operationKinds.includes(row.kind) ||
      !nonempty(row.definitionId) ||
      !Number.isFinite(row.durationMs) ||
      row.durationMs < 0 ||
      row.actor.kind === 'source'
    )
      throw new Error('Invalid operation');

    const status = row.outcome.status;
    const allowed =
      row.kind === 'invoke'
        ? ['succeeded', 'failed', 'rejected', 'uncertain']
        : row.kind === 'receipt'
          ? ['succeeded', 'failed', 'not-found', 'rejected']
          : row.kind === 'query'
            ? ['ok', 'rejected']
            : ['adopt', 'refresh'].includes(row.kind)
              ? ['ok', 'rejected', 'uncertain']
              : ['ok', 'not-found', 'rejected'];

    if (!allowed.includes(status)) throw new Error('Invalid operation outcome');

    keys(row.outcome, [
      'status',
      ...(['failed', 'rejected'].includes(status) ? ['code'] : []),
    ]);

    if (
      ['failed', 'rejected'].includes(status) &&
      !('code' in row.outcome && nonempty(row.outcome.code))
    )
      throw new Error('Missing outcome code');

    if (
      row.outcome.status === 'rejected' &&
      ![
        'incomplete',
        'invalid-request',
        'unavailable',
        'runtime-retired',
        'denied',
        'not-found',
        'invalid',
        'conflict',
        'unsupported',
        'internal',
      ].includes(row.outcome.code)
    )
      throw new Error('Invalid rejection code');

    if (row.kind === 'invoke' || row.kind === 'receipt') {
      if (
        ['succeeded', 'failed'].includes(status) !== Boolean(row.invocationId)
      )
        throw new Error('Invalid invocation identity');

      if (
        row.kind === 'invoke' &&
        (typeof row.replayed !== 'boolean' ||
          (row.replayed && !row.invocationId))
      )
        throw new Error('Invalid replay');
    }

    if (row.details.truncated) {
      keys(row.details.truncated, ['omittedObjects']);

      if (
        !Number.isSafeInteger(row.details.truncated.omittedObjects) ||
        row.details.truncated.omittedObjects < 1
      )
        throw new Error('Invalid truncation');
    }

    if (
      'hasMore' in row.details &&
      (typeof row.details.hasMore !== 'boolean' || row.outcome.status !== 'ok')
    )
      throw new Error('Invalid page outcome');

    keys(row.details, [
      'truncated',
      ...(row.kind === 'traverse'
        ? ['traversalId', 'from', 'hasMore']
        : row.kind === 'query'
          ? ['hasMore']
          : row.kind === 'refresh'
            ? ['refresh']
            : []),
    ]);

    if (
      row.kind === 'refresh' &&
      (status === 'ok'
        ? !['changed', 'unchanged', 'superseded'].includes(row.details.refresh!)
        : row.details.refresh !== undefined)
    )
      throw new Error('Invalid refresh');

    if ('target' in row && row.target) {
      ref(row.target);
      keys(row.target, ['objectDefinitionId', 'objectId']);
    }

    if ((row.kind === 'get' || row.kind === 'refresh') && !row.target)
      throw new Error('Missing target');

    if (row.kind === 'traverse') {
      ref(row.details.from);
      keys(row.details.from, ['objectDefinitionId', 'objectId']);

      if (!nonempty(row.details.traversalId))
        throw new Error('Invalid traversal');
    }

    for (const object of row.objects) {
      ref(object);
      keys(object, [
        'objectDefinitionId',
        'objectId',
        'role',
        'returned',
        'forbidden',
        'unavailable',
      ]);

      if (
        !['target', 'returned', 'traversal-origin'].includes(object.role) ||
        [object.returned, object.forbidden, object.unavailable].some(
          (a) => !Array.isArray(a) || a.some((id) => !nonempty(id)),
        )
      )
        throw new Error('Invalid lineage');
    }
  }
}

export function validateBatch(
  graphId: string,
  rows: readonly (FeedDraft | OperationDraft)[],
  config: ActivityLimits = {},
) {
  const limits = { ...activityLimits, ...config };

  if (
    rows.length > limits.maxEntries ||
    activityBytes(rows) > Math.min(limits.batchBytes, limits.maxBytes)
  )
    throw new Error('Activity batch too large');

  for (const row of rows) {
    validateActivity(row, graphId);

    if (activityBytes(row) > limits.rowBytes)
      throw new Error('Activity row too large');
  }
}

export function acceptedFeed(
  scope: StorageScope,
  objectId: string,
  previous: Observation | undefined,
  accepted: Observation,
  provenance?: AcceptanceProvenance,
): FeedDraft | undefined {
  const change = describeAcceptedChange(previous, accepted);

  if (!change || !provenance) return undefined;

  return {
    schemaVersion: 1,
    id: provenance.changeId,
    graphId: scope.graphId,
    definitionRevision: scope.definitionRevision,
    ...change,
    object: { objectDefinitionId: scope.objectDefinitionId, objectId },
    sourceDefinitionId: scope.sourceDefinitionId,
    operationId: provenance.operationId,
    ...(provenance.parentOperationId
      ? { parentOperationId: provenance.parentOperationId }
      : {}),
    actor:
      change.kind === 'adopted'
        ? provenance.actor
        : { kind: 'source', id: scope.sourceDefinitionId },
    ...(change.kind === 'adopted' ? {} : { triggeredBy: provenance.actor }),
    context: provenance.context,
    occurredAt: provenance.occurredAt,
  } satisfies Omit<Change, 'position' | 'recordedAt'>;
}
