import type { Manifest } from 'relate/model';
import { ActionError } from '@relate/protocol';
import type {
  ActionReceipt,
  ActivityObjectRef,
  FullPageResult,
  FullObjectResult as ReadResult,
  RejectedOutcome,
  UncertainOutcome,
} from '@relate/protocol';
import { lineageEntry, referenceEntry, rejected } from './capture.js';
import type { OperationBody, Settled } from './capture.js';

type Description<T> = (settled: Settled<T>) => OperationBody;

const ref = (objectDefinitionId: string, objectId: string) => ({
  objectDefinitionId,
  objectId,
});
const receiptOutcome = (receipt: ActionReceipt) =>
  receipt.state === 'succeeded'
    ? { status: 'succeeded' as const }
    : { status: 'failed' as const, code: receipt.error.code };

/**
 * Metadata-only projections of execution results. This module classifies
 * public protocol errors (`ReadError`, `ActionError`, including an uncertain
 * invocation) itself. Runtime-internal failures are classified by the module
 * that raises them: resolution supplies `adoptionFailure` and the refresh
 * outcome, so activity never imports execution modules.
 */
export function createOperationDescriptions(
  manifest: Manifest,
  adoptionFailure: (error: unknown) => RejectedOutcome | UncertainOutcome,
) {
  return {
    adopt(objectDefinitionId: string): Description<string> {
      return (settled): OperationBody => ({
        kind: 'adopt',
        definitionId: objectDefinitionId,
        ...(settled.ok
          ? {
              target: ref(objectDefinitionId, settled.value),
              outcome: { status: 'ok' },
              objects: [
                referenceEntry(
                  ref(objectDefinitionId, settled.value),
                  'target',
                ),
              ],
            }
          : {
              outcome: adoptionFailure(settled.error),
              objects: [],
            }),
        details: {},
      });
    },
    query(objectDefinitionId: string): Description<FullPageResult> {
      return (settled): OperationBody => ({
        kind: 'query',
        definitionId: objectDefinitionId,
        ...(settled.ok
          ? {
              outcome: { status: 'ok' },
              objects: settled.value.data.map((record) =>
                lineageEntry(manifest, objectDefinitionId, 'returned', record),
              ),
              details: { hasMore: !settled.value.meta.exhausted },
            }
          : { outcome: rejected(settled.error), objects: [], details: {} }),
      });
    },
    get(objectDefinitionId: string, objectId: string): Description<ReadResult> {
      const target = ref(objectDefinitionId, objectId);

      return (settled): OperationBody => ({
        kind: 'get',
        definitionId: objectDefinitionId,
        // The requested identity, without asserting the object exists:
        // hidden and missing objects share one outcome.
        target,
        outcome: settled.ok
          ? { status: settled.value.status }
          : rejected(settled.error),
        objects: [
          settled.ok && settled.value.status === 'ok'
            ? lineageEntry(
                manifest,
                objectDefinitionId,
                'target',
                settled.value,
              )
            : referenceEntry(target, 'target'),
        ],
        details: {},
      });
    },
    invoke(
      actionId: string,
    ): Description<{ receipt: ActionReceipt; replayed: boolean }> {
      return (settled): OperationBody => ({
        kind: 'invoke',
        definitionId: actionId,
        objects: [],
        details: {},
        ...(settled.ok
          ? {
              outcome: receiptOutcome(settled.value.receipt),
              invocationId: settled.value.receipt.invocationId,
              replayed: settled.value.replayed,
            }
          : {
              outcome:
                settled.error instanceof ActionError &&
                settled.error.code === 'uncertain'
                  ? { status: 'uncertain' }
                  : rejected(settled.error),
              replayed: false,
            }),
      });
    },
    receipt(actionId: string): Description<ActionReceipt> {
      return (settled): OperationBody => ({
        kind: 'receipt',
        definitionId: actionId,
        objects: [],
        details: {},
        ...(settled.ok
          ? {
              outcome: receiptOutcome(settled.value),
              invocationId: settled.value.invocationId,
            }
          : { outcome: rejected(settled.error) }),
      });
    },
    traverse(
      resultType: string,
      from: ActivityObjectRef,
      /** The relationship ID; it does not encode direction. */
      traversalId: string,
    ): Description<FullPageResult | ReadResult> {
      return (settled: Settled<FullPageResult | ReadResult>): OperationBody => {
        const origin = referenceEntry(from, 'traversal-origin');
        const details = { traversalId, from };

        if (!settled.ok)
          return {
            kind: 'traverse',
            definitionId: resultType,
            outcome: rejected(settled.error),
            objects: [origin],
            details,
          };

        const value = settled.value;

        if ('data' in value && 'meta' in value && !('status' in value))
          return {
            kind: 'traverse',
            definitionId: resultType,
            outcome: { status: 'ok' },
            objects: [
              origin,
              ...value.data.map((record) =>
                lineageEntry(manifest, resultType, 'returned', record),
              ),
            ],
            details: { ...details, hasMore: !value.meta.exhausted },
          };

        const one = value as ReadResult;

        return {
          kind: 'traverse',
          definitionId: resultType,
          outcome: { status: one.status },
          objects:
            one.status === 'ok'
              ? [origin, lineageEntry(manifest, resultType, 'returned', one)]
              : [origin],
          details,
        };
      };
    },
  };
}

type RefreshBody = Extract<OperationBody, { kind: 'refresh' }>;

/** Distributes over the ok/failed variants so each keeps its own details. */
export type RefreshOutcome = RefreshBody extends infer Body
  ? Body extends RefreshBody
    ? Pick<Body, 'outcome' | 'details'>
    : never
  : never;

/** A refresh's outcome comes from resolution; lineage and record shape live here. */
export function describeRefresh(
  target: ActivityObjectRef,
  settled: RefreshOutcome,
): RefreshBody {
  return {
    kind: 'refresh',
    definitionId: target.objectDefinitionId,
    target,
    objects: [referenceEntry(target, 'target')],
    ...settled,
  };
}
