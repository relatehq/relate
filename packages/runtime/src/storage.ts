import { ReadError } from '@relate/protocol';

/** Activity record contracts adapters persist; transport-safe protocol types. */
export { ActivityError } from '@relate/protocol';

export type {
  ActivityActor,
  ActivityObjectRef,
  ActivityPage,
  ActivityReadOptions,
  Change,
  FeedEntry,
  FeedFilter,
  InvocationEvent,
  ObjectProvenance,
  Operation,
  OperationActor,
  OperationContext,
  OperationFilter,
  OperationObject,
} from '@relate/protocol';

export type {
  StorageScope,
  Observation,
  StoredObject,
  Acceptance,
  AcceptAttribution,
  AcceptedChange,
  ActivityCaptureOptions,
  ActivityDiagnostic,
  ActivityDropReason,
  ActivityStore,
  ChangeDraft,
  FeedDraft,
  InvocationEventDraft,
  NativeCreation,
  ObservationStore,
  OperationDraft,
  NativeScope,
  NativeRecord,
  NativeInvocation,
  NativeReceiptRead,
  NativeTransaction,
  NativeStore,
  NativeScanOptions,
  NativeScanResult,
  SourceVersion,
} from 'relate/storage';

export class RetentionError extends Error {
  constructor(
    readonly outcome: 'failed' | 'unconfirmed',
    options?: ErrorOptions,
  ) {
    super('Observation retention did not complete normally', options);
    this.name = 'RetentionError';
  }
}

export {
  compareObservation,
  OrderingConflict,
} from './observations/ordering.js';

export { describeAcceptedChange } from './observations/changes.js';

export {
  activityBytes,
  activityPageLimits,
  decodeActivityCursor,
  encodeActivityCursor,
  feedEntryKinds,
  feedReadOptions,
  matchesFeedEntry,
  matchesOperation,
  operationKinds,
  operationOutcomes,
  operationReadOptions,
  sourceChangeDraft,
  validateFeedDraft,
  validateFeedFilter,
  validateOperationContext,
  validateOperationDraft,
  validateOperationFilter,
} from './activity-store.js';

export type { ActivityCursor } from './activity-store.js';

/** Scan order for opaque object IDs: UTF-8 bytewise, matching Postgres COLLATE "C". */
export function compareObjectIds(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  const surrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdfff;

  // Outside surrogates, UTF-16 code unit order is UTF-8 byte order. Avoid
  // allocating two buffers per comparison in scans and sorted traversals.
  for (let i = 0; i < length; i++) {
    const left = a.charCodeAt(i);
    const right = b.charCodeAt(i);

    if (left !== right)
      return surrogate(left) || surrogate(right)
        ? Buffer.compare(Buffer.from(a), Buffer.from(b))
        : left < right
          ? -1
          : 1;
  }

  if (a.length === b.length) return 0;

  return length > 0 && surrogate(a.charCodeAt(length - 1))
    ? Buffer.compare(Buffer.from(a), Buffer.from(b))
    : Math.sign(a.length - b.length);
}

type ScanBatch<T extends { readonly objectId: string }> = {
  readonly objects: readonly T[];
  readonly hasMore: boolean;
};

/**
 * One validated batch of a strictly ascending membership scan.
 *
 * Store failures are sanitized to `unavailable`; a store that violates the scan
 * protocol (oversized, nonadvancing or empty-but-unfinished batches) is
 * `incomplete`. Tokens are encrypted with a fresh nonce, so scan positions are
 * compared here: different token strings cannot detect a repeated boundary.
 * `objects` are the scanned snapshots, parallel to `ids`.
 */
export async function scanBatch<T extends { readonly objectId: string }>(
  scan: (input: {
    after?: string;
    limit: number;
  }) => Promise<ScanBatch<T> | undefined>,
  after: string | undefined,
  limit: number,
): Promise<{ ids: string[]; objects: readonly T[]; hasMore: boolean }> {
  let batch;

  try {
    batch = await scan({ ...(after !== undefined ? { after } : {}), limit });
  } catch {
    throw new ReadError('unavailable');
  }

  if (
    !batch ||
    typeof batch.hasMore !== 'boolean' ||
    batch.objects.length > limit ||
    (!batch.objects.length && batch.hasMore)
  )
    throw new ReadError('incomplete');

  const ids: string[] = [];

  for (const { objectId } of batch.objects) {
    if (
      typeof objectId !== 'string' ||
      !objectId ||
      (after !== undefined && compareObjectIds(objectId, after) <= 0)
    )
      throw new ReadError('incomplete');

    ids.push((after = objectId));
  }

  return { ids, objects: batch.objects, hasMore: batch.hasMore };
}

export class NativeConflict extends Error {}

/** Temporary storage failure. For native writes, COMMIT must not have succeeded. */
export class StorageUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super('Storage unavailable', options);
    this.name = 'StorageUnavailable';
  }
}

/** A lost COMMIT acknowledgement cannot be described as a confirmed rollback. */
export class NativeCommitUncertain extends Error {}
