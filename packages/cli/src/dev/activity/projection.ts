/**
 * Project the runtime's own activity (operation rows and committed feed
 * entries forwarded by the runtime host) onto the dev activity log. An
 * operation row carries the operation ID the dev binding assigned, so it
 * merges into that call's dispatch event; nested refreshes and feed entries
 * join the same request by request ID. Only metadata crosses: IDs, actors and
 * outcomes, never values.
 */
import type { FeedEntry, Operation } from '@relate/protocol';
import type { OperationEvent, RuntimeRecord } from '@relate/inspector/protocol';
import { activityLimits, text, type ActivityLog } from './log.js';

type Outcome = NonNullable<OperationEvent['outcome']>;

const actor = (value: { readonly kind: string; readonly id: string }) =>
  ({
    kind: value.kind,
    id: text(value.id),
  }) as RuntimeRecord['actor'];

const ids = (values: readonly string[]) =>
  [...new Set(values)].slice(0, activityLimits.recordIds).map(text);

function context(row: Operation | FeedEntry, runtimeId: string) {
  return {
    requestId: text(row.context.requestId),
    runtimeId: text(row.context.runtimeId ?? runtimeId),
    definitionRevision: text(row.definitionRevision),
    // A source change is shown under the principal whose read triggered it.
    principal: text(
      'triggeredBy' in row && row.triggeredBy
        ? row.triggeredBy.id
        : row.actor.id,
    ),
    transport: row.context.transport,
    ...(row.context.executionId
      ? { executionId: text(row.context.executionId) }
      : {}),
  };
}

function attempt(row: Operation, runtimeId: string): OperationEvent {
  const returned = row.objects.filter((o) => o.role !== 'traversal-origin');
  const failed = ['failed', 'rejected', 'uncertain'].includes(
    row.outcome.status,
  );
  const outcome: Outcome = {
    ...(row.kind === 'get' && !failed
      ? { found: row.outcome.status === 'ok' }
      : {}),
    ...((row.kind === 'query' || row.kind === 'traverse') && !failed
      ? {
          records: returned.length,
          ...('hasMore' in row.details
            ? { hasMore: row.details.hasMore === true }
            : {}),
        }
      : {}),
    ...((row.kind === 'invoke' || row.kind === 'receipt') &&
    (row.outcome.status === 'succeeded' || row.outcome.status === 'failed')
      ? { receiptState: row.outcome.status }
      : {}),
    ...('invocationId' in row && row.invocationId
      ? { invocationId: text(row.invocationId) }
      : {}),
    ...(row.outcome.status === 'rejected'
      ? { error: { code: text(row.outcome.code) } }
      : row.outcome.status === 'uncertain'
        ? { error: { code: 'uncertain' } }
        : {}),
  };
  const forbidden = ids(row.objects.flatMap((o) => o.forbidden));
  const runtime: RuntimeRecord = {
    record: 'attempt',
    ...(row.details.analytical ? { analytical: row.details.analytical } : {}),
    actor: actor(row.actor),
    outcome: row.outcome.status,
    ...('code' in row.outcome ? { code: text(row.outcome.code) } : {}),
    ...(row.parentOperationId
      ? { parentOperationId: row.parentOperationId }
      : {}),
    ...(row.kind === 'invoke' && row.replayed ? { replayed: true } : {}),
    ...(row.kind === 'refresh' && row.details.refresh
      ? { refresh: row.details.refresh }
      : {}),
    ...(forbidden.length ? { forbidden } : {}),
    ...(row.details.truncated
      ? { omittedObjects: row.details.truncated.omittedObjects }
      : {}),
  };

  return {
    kind: 'operation',
    opId: row.id,
    context: context(row, runtimeId),
    at: row.startedAt,
    op: row.kind === 'receipt' ? 'getReceipt' : row.kind,
    definitionId: text(row.definitionId),
    request: {},
    status: failed ? 'failed' : 'succeeded',
    ...(Object.keys(outcome).length ? { outcome } : {}),
    recordIds: ids(returned.map((o) => o.objectId)),
    ms: row.durationMs,
    runtime,
  };
}

function committed(row: FeedEntry, runtimeId: string): OperationEvent {
  const change = 'object' in row ? row : undefined;
  const event = change
    ? undefined
    : (row as Extract<FeedEntry, { actionDefinitionId: string }>);

  return {
    kind: 'operation',
    opId: row.id,
    context: context(row, runtimeId),
    at: row.occurredAt,
    op: row.kind,
    definitionId: text(
      change ? change.object.objectDefinitionId : event!.actionDefinitionId,
    ),
    request: {},
    status: row.kind === 'invocation-failed' ? 'failed' : 'succeeded',
    ...(event
      ? {
          outcome: {
            receiptState:
              row.kind === 'invocation-failed' ? 'failed' : 'succeeded',
            ...(row.invocationId
              ? { invocationId: text(row.invocationId) }
              : {}),
            ...(event.failureCode
              ? { error: { code: text(event.failureCode) } }
              : {}),
          },
        }
      : {}),
    recordIds: change ? [text(change.object.objectId)] : [],
    runtime: {
      record: 'committed',
      actor: actor(row.actor),
      position: row.position,
      ...(change?.triggeredBy
        ? { triggeredBy: actor(change.triggeredBy) }
        : {}),
      ...(change?.parentOperationId
        ? { parentOperationId: change.parentOperationId }
        : {}),
      ...(change ? { changedPropertyIds: ids(change.changedPropertyIds) } : {}),
    },
  };
}

export function projectActivity(
  log: ActivityLog,
  runtimeId: string,
  rows: {
    readonly feed: readonly FeedEntry[];
    readonly operations: readonly Operation[];
  },
): void {
  for (const row of rows.operations) log.record(attempt(row, runtimeId));

  for (const row of rows.feed) log.record(committed(row, runtimeId));
}
