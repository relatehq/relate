import type { OperationKind } from '@relate/protocol';
import type {
  ActivityCaptureOptions,
  ActivityDiagnostic,
  ActivityDropReason,
  ActivityStore,
  OperationDraft,
} from '../storage.js';

export type { ActivityCaptureOptions, ActivityDiagnostic, ActivityDropReason };

import { activityBytes, validateOperationDraft } from '../storage.js';

export interface ActivityCounters {
  readonly enqueued: number;
  readonly appended: number;
  readonly truncated: number;
  readonly dropped: Readonly<Record<ActivityDropReason, number>>;
}

export const activityCaptureDefaults = Object.freeze({
  queueEntries: 1_000,
  queueBytes: 8 * 1024 * 1024,
  batchEntries: 100,
  maxObjects: 1_000,
  maxOperationBytes: 256 * 1024,
});

function positiveInteger(value: number | undefined, fallback: number) {
  const result = value ?? fallback;

  if (!Number.isInteger(result) || result < 1)
    throw new Error('Activity capture limits must be positive integers');

  return result;
}

export type OperationRecorder = ReturnType<typeof createOperationRecorder>;

/**
 * One bounded queue per runtime with a single writer: at most one append is
 * in flight, failed batches are dropped and reported, and nothing is retried.
 * `record` never throws and never waits for delivery.
 */
export function createOperationRecorder(options: {
  readonly store?: ActivityStore;
  readonly graphId: string;
  readonly capture?: ActivityCaptureOptions;
}) {
  const capture = options.capture ?? {};
  const limits = {
    queueEntries: positiveInteger(
      capture.queueEntries,
      activityCaptureDefaults.queueEntries,
    ),
    queueBytes: positiveInteger(
      capture.queueBytes,
      activityCaptureDefaults.queueBytes,
    ),
    batchEntries: positiveInteger(
      capture.batchEntries,
      activityCaptureDefaults.batchEntries,
    ),
    maxObjects: positiveInteger(
      capture.maxObjects,
      activityCaptureDefaults.maxObjects,
    ),
    maxOperationBytes: positiveInteger(
      capture.maxOperationBytes,
      activityCaptureDefaults.maxOperationBytes,
    ),
  };

  if (
    capture.operations &&
    !['enabled', 'disabled'].includes(capture.operations)
  )
    throw new Error(
      "Activity operation capture must be 'enabled' or 'disabled'",
    );

  const store = options.store;
  const enabled = Boolean(store) && capture.operations !== 'disabled';
  const queue: { draft: OperationDraft; bytes: number }[] = [];
  let pendingBytes = 0;
  let inFlight: { entries: number; bytes: number } | undefined;
  let writer: Promise<void> | undefined;
  let closed = false;
  let enqueued = 0,
    appended = 0,
    truncated = 0;
  const dropped: Record<ActivityDropReason, number> = {
    'queue-full': 0,
    'append-failed': 0,
    oversized: 0,
    invalid: 0,
    shutdown: 0,
  };

  const notify = (diagnostic: ActivityDiagnostic) => {
    try {
      const result: unknown = capture.onDiagnostic?.(diagnostic);

      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Diagnostic callbacks cannot affect operations.
    }
  };
  const drop = (reason: ActivityDropReason, kinds: OperationKind[]) => {
    if (!kinds.length) return;

    dropped[reason] += kinds.length;
    notify({
      type: 'dropped',
      reason,
      count: kinds.length,
      kinds: [...new Set(kinds)],
    });
  };

  async function write() {
    while (queue.length) {
      const batch = queue.splice(0, limits.batchEntries);
      const bytes = batch.reduce((sum, item) => sum + item.bytes, 0);

      inFlight = { entries: batch.length, bytes };

      try {
        // Isolate synchronous throws as well as rejected promises.
        await Promise.resolve().then(() =>
          store!.appendOperations(
            options.graphId,
            batch.map((item) => item.draft),
          ),
        );
        appended += batch.length;
      } catch {
        drop(
          'append-failed',
          batch.map((item) => item.draft.kind),
        );
      } finally {
        pendingBytes -= bytes;
        inFlight = undefined;
      }
    }
  }

  const schedule = () => {
    writer ??= new Promise<void>((resolve) => setImmediate(resolve))
      .then(write)
      .finally(() => {
        writer = undefined;

        if (queue.length && !closed) schedule();
      });
  };

  return {
    enabled,
    limits,
    /** Count a truncated lineage; the draft itself carries `details.truncated`. */
    truncated(kind: OperationKind, omittedObjects: number) {
      truncated++;
      notify({ type: 'truncated', kind, omittedObjects });
    },
    record(draft: OperationDraft): void {
      if (!enabled) return;

      try {
        if (closed) return drop('shutdown', [draft.kind]);

        validateOperationDraft(draft);
        const bytes = activityBytes(draft);

        if (bytes > limits.maxOperationBytes)
          return drop('oversized', [draft.kind]);

        if (
          queue.length + (inFlight?.entries ?? 0) >= limits.queueEntries ||
          pendingBytes + bytes > limits.queueBytes
        )
          return drop('queue-full', [draft.kind]);

        queue.push({ draft, bytes });
        pendingBytes += bytes;
        enqueued++;
        schedule();
      } catch {
        drop('invalid', [draft?.kind ?? 'get']);
      }
    },
    /**
     * Stop accepting operations and flush within the deadline. Rows still
     * queued at expiry are abandoned and reported; a hung append is left to
     * its store's own I/O bounds.
     */
    async drain(deadlineMs: number): Promise<'drained' | 'abandoned'> {
      closed = true;

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => resolve('expired'), deadlineMs);
      });

      try {
        while (writer || queue.length) {
          if (!writer) schedule();

          if ((await Promise.race([writer, expired])) === 'expired') {
            const abandoned = queue.splice(0);

            pendingBytes -= abandoned.reduce(
              (sum, item) => sum + item.bytes,
              0,
            );
            drop(
              'shutdown',
              abandoned.map((item) => item.draft.kind),
            );

            return 'abandoned';
          }
        }

        return 'drained';
      } finally {
        clearTimeout(timer);
      }
    },
    counters(): ActivityCounters {
      return {
        enqueued,
        appended,
        truncated,
        dropped: { ...dropped },
      };
    },
  };
}
