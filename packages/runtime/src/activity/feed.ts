import type { ActionReceipt } from '@relate/protocol';
import type { FeedDraft, NativeRecord, NativeScope } from '../storage.js';
import type { OperationScope } from './scope.js';
import { uuidv7 } from './ids.js';

/**
 * Describe an invocation's committed effects. The executor stages these drafts
 * in its transaction; the store publishes them atomically with the receipt.
 * A domain failure retains its invocation event but none of its creations.
 */
export function invocationFeed(
  scope: NativeScope,
  attempt: OperationScope,
  result: {
    readonly actionDefinitionId: string;
    readonly receipt: ActionReceipt;
    readonly completedAt: number;
    readonly created: readonly NativeRecord[];
    /** Source changes accepted by this invocation's transaction. */
    readonly sourceChanges?: readonly FeedDraft[];
  },
): FeedDraft[] {
  const { receipt } = result;
  const envelope = {
    schemaVersion: 1 as const,
    graphId: scope.graphId,
    definitionRevision: scope.definitionRevision,
    operationId: attempt.id,
    invocationId: receipt.invocationId,
    actor: attempt.actor,
    context: attempt.context,
  };

  // Every business change precedes the invocation event in one batch.
  return [
    ...(receipt.state === 'failed' ? [] : (result.sourceChanges ?? [])),
    ...(receipt.state === 'failed' ? [] : result.created).map(
      (record): FeedDraft => ({
        ...envelope,
        id: uuidv7(),
        kind: 'created',
        object: {
          objectDefinitionId: record.objectDefinitionId,
          objectId: record.objectId,
        },
        changedPropertyIds: Object.keys(record.values).sort(),
        occurredAt: new Date(record.createdAt).toISOString(),
      }),
    ),
    {
      ...envelope,
      id: uuidv7(),
      actionDefinitionId: result.actionDefinitionId,
      occurredAt: new Date(result.completedAt).toISOString(),
      ...(receipt.state === 'failed'
        ? {
            kind: 'invocation-failed' as const,
            failureCode: receipt.error.code,
          }
        : { kind: 'invocation-succeeded' as const }),
    },
  ];
}
