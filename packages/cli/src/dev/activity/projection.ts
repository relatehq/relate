import type { FeedEntry, Operation } from '@relate/protocol';
import type { OperationEvent } from '@relate/inspector/protocol';
import type { ActivityLog } from './log.js';
import type { RuntimeConnection } from '../runtime-binding.js';

/** Bounded development projection. The protocol record is retained without values. */
export function projectActivity(
  log: ActivityLog,
  runtimeId: string,
  feed: readonly FeedEntry[],
  operations: readonly Operation[],
) {
  for (const row of [...feed, ...operations]) {
    const operation = 'outcome' in row ? row : undefined;
    const failed = operation
      ? ['failed', 'rejected', 'uncertain'].includes(operation.outcome.status)
      : row.kind === 'invocation-failed';
    const event: OperationEvent = {
      kind: 'operation',
      opId: `${row.graphId}:${row.id}`,
      at: operation ? operation.startedAt : (row as FeedEntry).occurredAt,
      context: {
        ...row.context,
        runtimeId: row.context.runtimeId ?? runtimeId,
        definitionRevision: row.definitionRevision,
        principal: row.actor.id,
      },
      op: row.kind === 'receipt' ? 'getReceipt' : row.kind,
      definitionId: operation
        ? operation.definitionId
        : 'object' in row
          ? row.object.objectDefinitionId
          : 'actionDefinitionId' in row
            ? row.actionDefinitionId
            : '',
      request: {},
      status: failed ? 'failed' : 'succeeded',
      recordIds: operation
        ? operation.objects.map((o) => o.objectId)
        : 'object' in row
          ? [row.object.objectId]
          : [],
      outcome: {},
      ...(operation ? { ms: operation.durationMs } : {}),
      runtimeRecord: row,
    };

    log.record(event);
  }
}

export function rejectedDispatch(
  log: ActivityLog,
  request: Extract<Parameters<RuntimeConnection['request']>[0], { type: 'op' }>,
  definitionRevision: string,
) {
  if (!request.scope) return;

  const { scope } = request;

  log.record({
    kind: 'operation',
    opId: scope.id,
    context: {
      ...scope.context,
      principal: request.principal,
      definitionRevision,
    },
    at: new Date().toISOString(),
    op: request.operation,
    definitionId: typeof request.args[0] === 'string' ? request.args[0] : '',
    request: {},
    status: 'failed',
    recordIds: [],
    outcome: { error: { code: 'runtime-retired' } },
    preDispatch: true,
  });
}
