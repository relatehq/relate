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
