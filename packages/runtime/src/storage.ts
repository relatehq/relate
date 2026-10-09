import { ReadError } from '@relate/protocol';

export type {
  StorageScope,
  Observation,
  StoredObject,
  Acceptance,
  ObservationStore,
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

/** Scan order for opaque object IDs: UTF-8 bytewise, matching Postgres COLLATE "C". */
export function compareObjectIds(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

type ScanBatch = {
  readonly objects: readonly { readonly objectId: string }[];
  readonly hasMore: boolean;
};

/**
 * One validated batch of a strictly ascending membership scan.
 *
 * Store failures are sanitized to `unavailable`; a store that violates the scan
 * protocol (oversized, nonadvancing or empty-but-unfinished batches) is
 * `incomplete`. Tokens are encrypted with a fresh nonce, so scan positions are
 * compared here: different token strings cannot detect a repeated boundary.
 */
export async function scanBatch(
  scan: (input: {
    after?: string;
    limit: number;
  }) => Promise<ScanBatch | undefined>,
  after: string | undefined,
  limit: number,
): Promise<{ ids: string[]; hasMore: boolean }> {
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

  return { ids, hasMore: batch.hasMore };
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
