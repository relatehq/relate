import { ActivityError, analyticalTimingStages } from '@relate/protocol';
import type {
  ActivityActor,
  ActivityFilter,
  ActivityObjectRef,
  ActivityReadOptions,
  FeedEntry,
  FeedFilter,
  Operation,
  OperationContext,
  OperationFilter,
} from '@relate/protocol';
import type {
  AcceptAttribution,
  AcceptedChange,
  ChangeDraft,
  FeedDraft,
  OperationDraft,
  StorageScope,
} from 'relate/storage';

/**
 * Shared activity semantics for storage adapters: draft validation, filter
 * validation and matching, cursors and page limits. Adapters own locking,
 * ordering and persistence; they do not reimplement these rules.
 */

export const feedEntryKinds = [
  'created',
  'adopted',
  'updated',
  'deleted',
  'restored',
  'invocation-succeeded',
  'invocation-failed',
] as const;

export const operationKinds = [
  'get',
  'query',
  'traverse',
  'invoke',
  'receipt',
  'adopt',
  'refresh',
] as const;

export const operationOutcomes = [
  'ok',
  'not-found',
  'succeeded',
  'failed',
  'rejected',
  'uncertain',
] as const;

const rejectionCodes = new Set([
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
]);

const contextKeys = [
  'requestId',
  'transport',
  'executionId',
  'runtimeId',
  'initiator',
] as const;

/** Page size bounds shared by feed reads and operation browsing. */
export const activityPageLimits = { default: 50, min: 1, max: 500 } as const;

class InvalidDraft extends Error {
  constructor(message: string) {
    super(`Invalid activity draft: ${message}`);
    this.name = 'InvalidDraft';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nonblank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function allowOnly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && value[key] !== undefined)
      throw new InvalidDraft(`${what} has unexpected field ${key}`);
}

function actor(value: unknown, kinds: readonly string[], what: string) {
  if (
    !isRecord(value) ||
    !kinds.includes(value.kind as string) ||
    !nonblank(value.id)
  )
    throw new InvalidDraft(`${what} actor`);

  allowOnly(value, ['kind', 'id'], what);
}

function objectRef(value: unknown, what: string) {
  if (
    !isRecord(value) ||
    !nonblank(value.objectDefinitionId) ||
    !nonblank(value.objectId)
  )
    throw new InvalidDraft(`${what} object reference`);

  allowOnly(value, ['objectDefinitionId', 'objectId'], what);
}

/** Only these context keys are stored; typed request fields are the truth. */
export function validateOperationContext(value: unknown): OperationContext {
  if (
    !isRecord(value) ||
    !nonblank(value.requestId) ||
    !['embedded', 'http', 'mcp'].includes(value.transport as string)
  )
    throw new InvalidDraft('context');

  allowOnly(value, contextKeys, 'context');

  for (const key of ['executionId', 'runtimeId'] as const)
    if (value[key] !== undefined && !nonblank(value[key]))
      throw new InvalidDraft(`context ${key}`);

  if (value.initiator !== undefined)
    actor(value.initiator, ['principal', 'system', 'source'], 'initiator');

  return value as unknown as OperationContext;
}

function envelope(draft: Record<string, unknown>) {
  if (draft.schemaVersion !== 1) throw new InvalidDraft('schema version');

  for (const key of ['id', 'graphId', 'definitionRevision'] as const)
    if (!nonblank(draft[key])) throw new InvalidDraft(key);

  validateOperationContext(draft.context);
}

/** Reject malformed or cross-variant feed drafts at the write boundary. */
export function validateFeedDraft(input: unknown): FeedDraft {
  if (!isRecord(input)) throw new InvalidDraft('feed entry');

  const draft = input;

  envelope(draft);

  if (!nonblank(draft.operationId)) throw new InvalidDraft('operationId');

  if (!timestamp(draft.occurredAt)) throw new InvalidDraft('occurredAt');

  const common = [
    'schemaVersion',
    'id',
    'graphId',
    'definitionRevision',
    'kind',
    'operationId',
    'actor',
    'context',
    'occurredAt',
  ];

  if (
    draft.kind === 'invocation-succeeded' ||
    draft.kind === 'invocation-failed'
  ) {
    allowOnly(
      draft,
      [...common, 'actionDefinitionId', 'invocationId', 'failureCode'],
      draft.kind,
    );
    actor(draft.actor, ['principal', 'system'], draft.kind);

    if (!nonblank(draft.actionDefinitionId) || !nonblank(draft.invocationId))
      throw new InvalidDraft('invocation event identity');

    if (
      (draft.kind === 'invocation-failed') !==
      (draft.failureCode !== undefined)
    )
      throw new InvalidDraft('invocation failure code');

    if (draft.failureCode !== undefined && !nonblank(draft.failureCode))
      throw new InvalidDraft('invocation failure code');

    return draft as unknown as FeedDraft;
  }

  if (!feedEntryKinds.includes(draft.kind as never))
    throw new InvalidDraft('kind');

  allowOnly(
    draft,
    [
      ...common,
      'object',
      'changedPropertyIds',
      'parentOperationId',
      'invocationId',
      'triggeredBy',
      'sourceDefinitionId',
    ],
    String(draft.kind),
  );
  objectRef(draft.object, 'change');

  if (!strings(draft.changedPropertyIds))
    throw new InvalidDraft('changedPropertyIds');

  if (
    (draft.kind === 'deleted' || draft.kind === 'restored') &&
    draft.changedPropertyIds.length
  )
    throw new InvalidDraft('deletion and restoration list no properties');

  if (
    draft.parentOperationId !== undefined &&
    !nonblank(draft.parentOperationId)
  )
    throw new InvalidDraft('parentOperationId');

  const source = draft.sourceDefinitionId;

  if (source !== undefined && !nonblank(source))
    throw new InvalidDraft('sourceDefinitionId');

  if (draft.kind === 'created' && source !== undefined)
    throw new InvalidDraft('created changes have no source');

  if (draft.kind === 'adopted' && source === undefined)
    throw new InvalidDraft('adopted changes name their source');

  if (source === undefined) {
    // A native change: committed by an invocation, by its actor.
    actor(draft.actor, ['principal', 'system'], 'native change');

    if (!nonblank(draft.invocationId) || draft.triggeredBy !== undefined)
      throw new InvalidDraft('native change attribution');
  } else if (draft.invocationId !== undefined)
    throw new InvalidDraft('source changes do not inherit an invocation');
  else if (draft.kind === 'adopted') {
    actor(draft.actor, ['principal', 'system'], 'adoption');

    if (draft.triggeredBy !== undefined)
      throw new InvalidDraft('adoption has no trigger');
  } else {
    actor(draft.actor, ['source'], 'source change');

    if ((draft.actor as ActivityActor).id !== source)
      throw new InvalidDraft('source change actor names its source');

    actor(draft.triggeredBy, ['principal', 'system'], 'trigger');
  }

  return draft as unknown as FeedDraft;
}

function lineage(value: unknown) {
  if (!Array.isArray(value)) throw new InvalidDraft('objects');

  for (const item of value) {
    if (
      !isRecord(item) ||
      !['target', 'returned', 'traversal-origin'].includes(item.role as string)
    )
      throw new InvalidDraft('lineage role');

    allowOnly(
      item,
      [
        'objectDefinitionId',
        'objectId',
        'role',
        'returned',
        'forbidden',
        'unavailable',
      ],
      'lineage',
    );

    if (
      !nonblank(item.objectDefinitionId) ||
      !nonblank(item.objectId) ||
      !strings(item.returned) ||
      !strings(item.forbidden) ||
      !strings(item.unavailable)
    )
      throw new InvalidDraft('lineage entry');
  }
}

function outcome(value: unknown, statuses: readonly string[]) {
  if (!isRecord(value) || !statuses.includes(value.status as string))
    throw new InvalidDraft('outcome');

  if (value.status === 'failed') {
    allowOnly(value, ['status', 'code'], 'outcome');

    if (!nonblank(value.code)) throw new InvalidDraft('failure code');
  } else if (value.status === 'rejected') {
    allowOnly(value, ['status', 'code'], 'outcome');

    if (!rejectionCodes.has(value.code as string))
      throw new InvalidDraft('rejection code');
  } else allowOnly(value, ['status'], 'outcome');

  return value.status as string;
}

/** Reject malformed or cross-variant operation drafts at the write boundary. */
export function validateOperationDraft(input: unknown): OperationDraft {
  if (!isRecord(input)) throw new InvalidDraft('operation');

  const draft = input;

  envelope(draft);
  actor(draft.actor, ['principal', 'system'], 'operation');

  if (!operationKinds.includes(draft.kind as never))
    throw new InvalidDraft('kind');

  if (!nonblank(draft.definitionId)) throw new InvalidDraft('definitionId');

  if (
    draft.parentOperationId !== undefined &&
    !nonblank(draft.parentOperationId)
  )
    throw new InvalidDraft('parentOperationId');

  if (!timestamp(draft.startedAt) || !timestamp(draft.completedAt))
    throw new InvalidDraft('timing');

  if (
    typeof draft.durationMs !== 'number' ||
    !Number.isFinite(draft.durationMs) ||
    draft.durationMs < 0
  )
    throw new InvalidDraft('durationMs');

  lineage(draft.objects);

  const details = draft.details;

  if (!isRecord(details)) throw new InvalidDraft('details');

  if (details.truncated !== undefined) {
    const truncated = details.truncated;

    if (
      !isRecord(truncated) ||
      !Number.isInteger(truncated.omittedObjects) ||
      (truncated.omittedObjects as number) < 1
    )
      throw new InvalidDraft('truncation');

    allowOnly(truncated, ['omittedObjects'], 'truncation');
  }

  if (details.analytical !== undefined) {
    const analytical = details.analytical;

    if (
      !['get', 'query'].includes(draft.kind as string) ||
      !isRecord(analytical) ||
      !isRecord(analytical.stages)
    )
      throw new InvalidDraft('analytical timings');

    allowOnly(analytical, ['stages'], 'analytical timings');
    allowOnly(analytical.stages, analyticalTimingStages, 'analytical stages');

    for (const timing of Object.values(analytical.stages)) {
      if (
        !isRecord(timing) ||
        !Number.isSafeInteger(timing.count) ||
        (timing.count as number) < 1 ||
        typeof timing.totalMs !== 'number' ||
        !Number.isFinite(timing.totalMs) ||
        timing.totalMs < 0 ||
        typeof timing.maxMs !== 'number' ||
        !Number.isFinite(timing.maxMs) ||
        timing.maxMs < 0 ||
        timing.maxMs > timing.totalMs
      )
        throw new InvalidDraft('analytical stage timing');

      allowOnly(
        timing,
        ['count', 'totalMs', 'maxMs'],
        'analytical stage timing',
      );
    }
  }

  const common = [
    'schemaVersion',
    'id',
    'parentOperationId',
    'graphId',
    'definitionRevision',
    'actor',
    'context',
    'startedAt',
    'completedAt',
    'durationMs',
    'objects',
    'kind',
    'definitionId',
    'outcome',
    'details',
  ];
  const kind = draft.kind as Operation['kind'];
  const hasMore = (status: string) => {
    if (details.hasMore === undefined) return;

    if (typeof details.hasMore !== 'boolean' || status !== 'ok')
      throw new InvalidDraft('hasMore belongs to successful pages');
  };

  switch (kind) {
    case 'get': {
      allowOnly(draft, [...common, 'target'], kind);
      objectRef(draft.target, kind);
      outcome(draft.outcome, ['ok', 'not-found', 'rejected']);
      allowOnly(details, ['truncated', 'analytical'], 'details');
      break;
    }
    case 'query': {
      allowOnly(draft, common, kind);
      hasMore(outcome(draft.outcome, ['ok', 'rejected']));
      allowOnly(details, ['truncated', 'hasMore', 'analytical'], 'details');
      break;
    }
    case 'traverse': {
      allowOnly(draft, common, kind);
      hasMore(outcome(draft.outcome, ['ok', 'not-found', 'rejected']));
      allowOnly(
        details,
        ['truncated', 'hasMore', 'traversalId', 'from'],
        'details',
      );

      if (!nonblank(details.traversalId)) throw new InvalidDraft('traversalId');

      objectRef(details.from, 'traversal origin');
      break;
    }
    case 'invoke':
    case 'receipt': {
      allowOnly(
        draft,
        [...common, 'invocationId', ...(kind === 'invoke' ? ['replayed'] : [])],
        kind,
      );
      allowOnly(details, ['truncated'], 'details');

      const status = outcome(
        draft.outcome,
        kind === 'invoke'
          ? ['succeeded', 'failed', 'rejected', 'uncertain']
          : ['succeeded', 'failed', 'not-found', 'rejected'],
      );
      const terminal = status === 'succeeded' || status === 'failed';

      if (terminal !== nonblank(draft.invocationId))
        throw new InvalidDraft('invocation ID follows a terminal outcome');

      if (kind === 'invoke') {
        if (typeof draft.replayed !== 'boolean')
          throw new InvalidDraft('replayed');

        if (draft.replayed && !terminal)
          throw new InvalidDraft('a replay has an invocation');
      }

      break;
    }
    case 'adopt': {
      allowOnly(draft, [...common, 'target'], kind);

      if (draft.target !== undefined) objectRef(draft.target, kind);

      outcome(draft.outcome, ['ok', 'rejected', 'uncertain']);
      allowOnly(details, ['truncated'], 'details');
      break;
    }
    case 'refresh': {
      allowOnly(draft, [...common, 'target'], kind);
      objectRef(draft.target, kind);
      allowOnly(details, ['truncated', 'refresh'], 'details');

      const status = outcome(draft.outcome, ['ok', 'rejected', 'uncertain']);

      if (
        status === 'ok'
          ? !['changed', 'unchanged', 'superseded'].includes(
              details.refresh as string,
            )
          : details.refresh !== undefined
      )
        throw new InvalidDraft('refresh result follows a confirmed outcome');

      break;
    }
  }

  return draft as unknown as OperationDraft;
}

/** The feed draft for one source-backed transition decided under an acceptance lock. */
export function sourceChangeDraft(
  scope: StorageScope,
  objectId: string,
  attribution: AcceptAttribution,
  change: Omit<AcceptedChange, 'id'>,
): ChangeDraft {
  const base = {
    schemaVersion: 1 as const,
    id: attribution.changeId,
    graphId: scope.graphId,
    definitionRevision: scope.definitionRevision,
    kind: change.kind,
    object: { objectDefinitionId: scope.objectDefinitionId, objectId },
    changedPropertyIds: [...change.changedPropertyIds],
    operationId: attribution.operationId,
    ...(attribution.parentOperationId !== undefined
      ? { parentOperationId: attribution.parentOperationId }
      : {}),
    context: structuredClone(attribution.context),
    occurredAt: new Date(attribution.occurredAt).toISOString(),
    sourceDefinitionId: scope.sourceDefinitionId,
  };

  // Adoption names the adopting actor. A refresh names the source where Relate
  // observed the change and snapshots the actor that triggered the observation.
  return change.kind === 'adopted'
    ? { ...base, actor: structuredClone(attribution.actor) }
    : {
        ...base,
        actor: { kind: 'source', id: scope.sourceDefinitionId },
        triggeredBy: structuredClone(attribution.actor),
      };
}

/** UTF-8 JSON size, the retained-byte accounting convention for both families. */
export function activityBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

const invalidRequest = () => new ActivityError('invalid-request');

function filterActor(value: unknown) {
  if (
    !isRecord(value) ||
    !['principal', 'system', 'source'].includes(value.kind as string) ||
    !nonblank(value.id) ||
    Object.keys(value).some((key) => key !== 'kind' && key !== 'id')
  )
    throw invalidRequest();
}

function baseFilter(filter: Record<string, unknown>) {
  if (filter.actor !== undefined) filterActor(filter.actor);

  for (const key of [
    'objectDefinitionId',
    'invocationId',
    'operationId',
    'requestId',
  ] as const)
    if (filter[key] !== undefined && !nonblank(filter[key]))
      throw invalidRequest();

  if (filter.object !== undefined) {
    const object = filter.object;

    if (
      !isRecord(object) ||
      !nonblank(object.objectDefinitionId) ||
      !nonblank(object.objectId) ||
      Object.keys(object).some(
        (key) => key !== 'objectDefinitionId' && key !== 'objectId',
      )
    )
      throw invalidRequest();

    // Contradictory object and object-definition filters can never match.
    if (
      filter.objectDefinitionId !== undefined &&
      filter.objectDefinitionId !== object.objectDefinitionId
    )
      throw invalidRequest();
  }

  for (const key of ['from', 'to'] as const)
    if (filter[key] !== undefined && !timestamp(filter[key]))
      throw invalidRequest();
}

function members(value: unknown, allowed: readonly string[]) {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      !value.length ||
      value.some((item) => !allowed.includes(item as string)))
  )
    throw invalidRequest();
}

export function validateFeedFilter(input: unknown): FeedFilter {
  if (input === undefined) return {};

  if (!isRecord(input)) throw invalidRequest();

  const allowed = [
    'actor',
    'objectDefinitionId',
    'object',
    'invocationId',
    'operationId',
    'requestId',
    'from',
    'to',
    'kinds',
    'sourceDefinitionId',
    'actionDefinitionId',
  ];

  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw invalidRequest();

  baseFilter(input);
  members(input.kinds, feedEntryKinds);

  for (const key of ['sourceDefinitionId', 'actionDefinitionId'] as const)
    if (input[key] !== undefined && !nonblank(input[key]))
      throw invalidRequest();

  return structuredClone(input) as FeedFilter;
}

export function validateOperationFilter(input: unknown): OperationFilter {
  if (input === undefined) return {};

  if (!isRecord(input)) throw invalidRequest();

  const allowed = [
    'actor',
    'objectDefinitionId',
    'object',
    'invocationId',
    'operationId',
    'requestId',
    'from',
    'to',
    'kinds',
    'objectRole',
    'outcomes',
  ];

  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw invalidRequest();

  baseFilter(input);
  members(input.kinds, operationKinds);
  members(input.outcomes, operationOutcomes);

  if (input.objectRole !== undefined) {
    if (
      !['target', 'returned', 'traversal-origin'].includes(
        input.objectRole as string,
      ) ||
      (input.object === undefined && input.objectDefinitionId === undefined)
    )
      throw invalidRequest();
  }

  return structuredClone(input) as OperationFilter;
}

const sameActor = (a: ActivityActor, b: ActivityActor) =>
  a.kind === b.kind && a.id === b.id;

const sameObject = (a: ActivityObjectRef, b: ActivityObjectRef) =>
  a.objectDefinitionId === b.objectDefinitionId && a.objectId === b.objectId;

function inRange(filter: ActivityFilter, at: string) {
  const time = Date.parse(at);

  return (
    (filter.from === undefined || time >= Date.parse(filter.from)) &&
    (filter.to === undefined || time <= Date.parse(filter.to))
  );
}

/** Direct references only; actor filters match `actor`, never `triggeredBy`. */
export function matchesFeedEntry(filter: FeedFilter, entry: FeedEntry) {
  const change = 'object' in entry ? entry : undefined;

  return (
    (!filter.kinds || filter.kinds.includes(entry.kind)) &&
    (!filter.actor || sameActor(filter.actor, entry.actor)) &&
    (filter.objectDefinitionId === undefined ||
      change?.object.objectDefinitionId === filter.objectDefinitionId) &&
    (!filter.object ||
      (change !== undefined && sameObject(filter.object, change.object))) &&
    (filter.invocationId === undefined ||
      entry.invocationId === filter.invocationId) &&
    (filter.operationId === undefined ||
      entry.operationId === filter.operationId) &&
    (filter.requestId === undefined ||
      entry.context.requestId === filter.requestId) &&
    (filter.sourceDefinitionId === undefined ||
      change?.sourceDefinitionId === filter.sourceDefinitionId) &&
    (filter.actionDefinitionId === undefined ||
      (!change &&
        'actionDefinitionId' in entry &&
        entry.actionDefinitionId === filter.actionDefinitionId)) &&
    inRange(filter, entry.occurredAt)
  );
}

/**
 * Object-definition filters match lineage and the result definition; a role
 * filter requires a matching lineage reference. An operation-ID filter
 * matches the operation and the operations nested directly under it.
 */
export function matchesOperation(
  filter: OperationFilter,
  operation: Operation,
) {
  const role = filter.objectRole;
  const lineage = operation.objects.filter(
    (object) => role === undefined || object.role === role,
  );

  return (
    (!filter.kinds || filter.kinds.includes(operation.kind)) &&
    (!filter.outcomes || filter.outcomes.includes(operation.outcome.status)) &&
    (!filter.actor || sameActor(filter.actor, operation.actor)) &&
    (filter.objectDefinitionId === undefined ||
      lineage.some(
        (object) => object.objectDefinitionId === filter.objectDefinitionId,
      ) ||
      (role === undefined &&
        operation.definitionId === filter.objectDefinitionId)) &&
    (!filter.object ||
      lineage.some((object) => sameObject(filter.object!, object))) &&
    (filter.invocationId === undefined ||
      ('invocationId' in operation &&
        operation.invocationId === filter.invocationId)) &&
    (filter.operationId === undefined ||
      operation.id === filter.operationId ||
      operation.parentOperationId === filter.operationId) &&
    (filter.requestId === undefined ||
      operation.context.requestId === filter.requestId) &&
    inRange(filter, operation.startedAt)
  );
}

export type ActivityCursor =
  | {
      readonly method: 'feed';
      readonly graphId: string;
      readonly streamId: string;
      /** Last scanned position, as a decimal string. */
      readonly position: string;
      readonly filter: FeedFilter;
    }
  | {
      readonly method: 'operations';
      readonly graphId: string;
      /** Exclusive descending bound: rows strictly before this pair. */
      readonly recordedAt: string;
      readonly id: string;
      readonly filter: OperationFilter;
    };

/** Opaque to callers; trusted host APIs need integrity checks, not secrecy. */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString('base64url');
}

export function decodeActivityCursor<M extends ActivityCursor['method']>(
  token: unknown,
  method: M,
  graphId: string,
): Extract<ActivityCursor, { method: M }> {
  const invalid = () => new ActivityError('invalid-cursor');

  if (!nonblank(token) || token.length > 16_384) throw invalid();

  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (
    !isRecord(value) ||
    value.v !== 1 ||
    value.method !== method ||
    value.graphId !== graphId
  )
    throw invalid();

  try {
    if (method === 'feed') {
      if (
        !nonblank(value.streamId) ||
        typeof value.position !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(value.position)
      )
        throw invalid();

      return {
        method,
        graphId,
        streamId: value.streamId,
        position: value.position,
        filter: validateFeedFilter(value.filter),
      } as Extract<ActivityCursor, { method: M }>;
    }

    if (!timestamp(value.recordedAt) || !nonblank(value.id)) throw invalid();

    return {
      method,
      graphId,
      recordedAt: value.recordedAt,
      id: value.id,
      filter: validateOperationFilter(value.filter),
    } as Extract<ActivityCursor, { method: M }>;
  } catch {
    throw invalid();
  }
}

type FeedCursor = Extract<ActivityCursor, { method: 'feed' }>;

type OperationCursor = Extract<ActivityCursor, { method: 'operations' }>;

function readOptions(options: unknown) {
  if (options === undefined) options = {};

  if (
    !isRecord(options) ||
    Object.keys(options).some(
      (key) => !['filter', 'cursor', 'limit'].includes(key),
    ) ||
    (options.filter !== undefined && options.cursor !== undefined)
  )
    throw invalidRequest();

  const limit = options.limit ?? activityPageLimits.default;

  if (
    !Number.isInteger(limit) ||
    (limit as number) < activityPageLimits.min ||
    (limit as number) > activityPageLimits.max
  )
    throw invalidRequest();

  return { limit: limit as number, options };
}

/**
 * Validate feed read options: a filter begins a sequence, a cursor resumes it
 * with its stored filter, and supplying both is invalid even when they agree.
 */
export function feedReadOptions(
  input: unknown,
  graphId: string,
): { limit: number; filter: FeedFilter; cursor?: FeedCursor } {
  const { limit, options } = readOptions(input);

  if (options.cursor === undefined)
    return { limit, filter: validateFeedFilter(options.filter) };

  const cursor = decodeActivityCursor(options.cursor, 'feed', graphId);

  return { limit, filter: cursor.filter, cursor };
}

/** Validate operation browsing options, with the same cursor/filter rules. */
export function operationReadOptions(
  input: unknown,
  graphId: string,
): { limit: number; filter: OperationFilter; cursor?: OperationCursor } {
  const { limit, options } = readOptions(input);

  if (options.cursor === undefined)
    return { limit, filter: validateOperationFilter(options.filter) };

  const cursor = decodeActivityCursor(options.cursor, 'operations', graphId);

  return { limit, filter: cursor.filter, cursor };
}

export type { ActivityReadOptions };
