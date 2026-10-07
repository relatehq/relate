import { StorageUnavailable } from '@relate/runtime/storage';

function code(error: unknown): string | undefined {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Server responses that confirm rejection, even when the command was COMMIT. */
export function transactionRejected(error: unknown): boolean {
  return ['40001', '40P01', '25P02', '25P03', '55P03', '57014'].includes(
    code(error) ?? '',
  );
}

/** Classify at the adapter boundary; never use this to resolve an ambiguous COMMIT. */
export function storageError(error: unknown): unknown {
  const errorCode = code(error);
  const unavailable =
    transactionRejected(error) ||
    errorCode?.startsWith('08') ||
    [
      '53300',
      '57P01',
      '57P02',
      '57P03',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN',
    ].includes(errorCode ?? '') ||
    // pg/pg-pool use plain Errors without codes for these connection failures.
    (error instanceof Error &&
      [
        'timeout exceeded when trying to connect',
        'Connection terminated due to connection timeout',
        'Connection terminated unexpectedly',
        'Connection terminated',
        'Client has encountered a connection error and is not queryable',
      ].includes(error.message));

  return unavailable ? new StorageUnavailable({ cause: error }) : error;
}
