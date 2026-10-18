import { randomUUID } from 'node:crypto';
import { ActivityError } from '@relate/protocol';
import type { FeedEntry, Operation } from '@relate/protocol';
import type { ActivityStore, FeedDraft } from './storage.js';
import {
  activityBytes,
  feedReadOptions,
  operationReadOptions,
  encodeActivityCursor,
  matchesFeedEntry,
  matchesOperation,
  validateFeedDraft,
  validateOperationDraft,
} from './storage.js';

/** Retention and write bounds for memory activity; all are UTF-8 JSON bytes or counts. */
export interface MemoryActivityLimits {
  /** Retained feed entries per graph; defaults to 10,000. */
  readonly feedEntries?: number;
  /** Retained feed bytes per graph; defaults to 32 MiB. */
  readonly feedBytes?: number;
  /** Retained operations per graph, including lineage; defaults to 10,000. */
  readonly operations?: number;
  /** Retained operation bytes per graph, including lineage; defaults to 64 MiB. */
  readonly operationBytes?: number;
  /** Largest single feed entry or operation; defaults to 256 KiB. */
  readonly rowBytes?: number;
  /** Largest feed or operation append batch; defaults to 8 MiB. */
  readonly batchBytes?: number;
}

export const memoryActivityDefaults = Object.freeze({
  feedEntries: 10_000,
  feedBytes: 32 * 1024 * 1024,
  operations: 10_000,
  operationBytes: 64 * 1024 * 1024,
  rowBytes: 256 * 1024,
  batchBytes: 8 * 1024 * 1024,
});

/** A feed batch the retained limits cannot hold; its transaction must not commit. */
export class FeedCapacityExceeded extends Error {
  constructor() {
    super('Feed batch exceeds retained activity limits');
    this.name = 'FeedCapacityExceeded';
  }
}

interface Feed {
  readonly streamId: string;
  position: bigint;
  floor: bigint;
  bytes: number;
  readonly entries: { entry: FeedEntry; position: bigint; bytes: number }[];
}

interface Operations {
  bytes: number;
  readonly rows: Map<string, { operation: Operation; bytes: number }>;
}

// Resuming from this bound returns nothing: every row is newer.
const floor = {
  recordedAt: new Date(0).toISOString(),
  id: '00000000-0000-0000-0000-000000000000',
};

/** Volatile feed and operation history with bounded retention. */
export function createMemoryActivity(input: MemoryActivityLimits = {}) {
  const limits: Record<keyof MemoryActivityLimits, number> = {
    ...memoryActivityDefaults,
  };

  for (const [key, value] of Object.entries(input) as [
    keyof MemoryActivityLimits,
    number | undefined,
  ][])
    if (value !== undefined) {
      if (!Number.isInteger(value) || value < 1)
        throw new Error('Memory activity limits must be positive integers');

      limits[key] = value;
    }

  const feeds = new Map<string, Feed>();
  const histories = new Map<string, Operations>();
  const feedFor = (graphId: string) => {
    let feed = feeds.get(graphId);

    if (!feed) {
      // A new store is a new stream: cursors from an earlier store expire.
      feed = {
        streamId: randomUUID(),
        position: 0n,
        floor: 0n,
        bytes: 0,
        entries: [],
      };
      feeds.set(graphId, feed);
    }

    return feed;
  };

  /**
   * Validate and size a batch without mutating anything. The returned commit
   * is synchronous and cannot fail, so callers run it inside their atomic
   * section after every other check has passed.
   */
  function prepareFeed(graphId: string, drafts: readonly FeedDraft[]) {
    const sized = drafts.map((draft) => {
      validateFeedDraft(draft);

      if (draft.graphId !== graphId)
        throw new Error('Feed draft belongs to another graph');

      return { draft: structuredClone(draft), bytes: activityBytes(draft) };
    });
    const total = sized.reduce((sum, item) => sum + item.bytes, 0);

    if (
      sized.some((item) => item.bytes > limits.rowBytes) ||
      total > limits.batchBytes ||
      sized.length > limits.feedEntries ||
      total > limits.feedBytes
    )
      throw new FeedCapacityExceeded();

    return () => {
      if (!sized.length) return;

      const feed = feedFor(graphId);
      const recordedAt = new Date().toISOString();

      // Evict a contiguous publication prefix; never part of the new batch.
      while (
        feed.entries.length &&
        (feed.entries.length + sized.length > limits.feedEntries ||
          feed.bytes + total > limits.feedBytes)
      ) {
        const evicted = feed.entries.shift()!;

        feed.bytes -= evicted.bytes;
        feed.floor = evicted.position;
      }

      for (const item of sized) {
        const position = ++feed.position;

        feed.entries.push({
          entry: {
            ...item.draft,
            position: String(position),
            recordedAt,
          } as FeedEntry,
          position,
          bytes: item.bytes,
        });
        feed.bytes += item.bytes;
      }
    };
  }

  const store: ActivityStore = {
    atomicFeed: { sourceAcceptance: true, nativeTransactions: true },
    async appendOperations(graphId, drafts) {
      const sized = drafts.map((draft) => {
        validateOperationDraft(draft);

        if (draft.graphId !== graphId)
          throw new Error('Operation draft belongs to another graph');

        return { draft: structuredClone(draft), bytes: activityBytes(draft) };
      });
      const total = sized.reduce((sum, item) => sum + item.bytes, 0);

      // A row larger than retention would evict itself, and every older row,
      // after resolving; reject it so the recorder reports the drop.
      if (
        sized.some(
          (item) =>
            item.bytes > limits.rowBytes || item.bytes > limits.operationBytes,
        ) ||
        total > limits.batchBytes
      )
        throw new Error('Operation batch exceeds activity limits');

      let history = histories.get(graphId);

      if (!history)
        histories.set(graphId, (history = { bytes: 0, rows: new Map() }));

      const recordedAt = new Date().toISOString();

      for (const item of sized) {
        // First write wins by ID, within and across batches; never amend lineage.
        if (history.rows.has(item.draft.id)) continue;

        history.rows.set(item.draft.id, {
          operation: { ...item.draft, recordedAt } as Operation,
          bytes: item.bytes,
        });
        history.bytes += item.bytes;

        for (const [id, row] of history.rows) {
          if (
            history.rows.size <= limits.operations &&
            history.bytes <= limits.operationBytes
          )
            break;

          history.rows.delete(id);
          history.bytes -= row.bytes;
        }
      }
    },
    feed: {
      async read(graphId, options) {
        const { limit, filter, cursor } = feedReadOptions(options, graphId);
        const feed = feedFor(graphId);
        const highWater = feed.position;
        let after = feed.floor;

        if (cursor) {
          const position = BigInt(cursor.position);

          if (cursor.streamId !== feed.streamId || position < feed.floor)
            throw new ActivityError('cursor-expired');

          if (position > highWater) throw new ActivityError('invalid-cursor');

          after = position;
        }

        const matches: { entry: FeedEntry; position: bigint }[] = [];

        for (const item of feed.entries) {
          if (item.position <= after) continue;

          if (item.position > highWater || matches.length > limit) break;

          if (matchesFeedEntry(filter, item.entry)) matches.push(item);
        }

        const hasMore = matches.length > limit;
        const page = matches.slice(0, limit);

        return {
          entries: structuredClone(page.map((item) => item.entry)),
          nextCursor: encodeActivityCursor({
            method: 'feed',
            graphId,
            streamId: feed.streamId,
            position: String(hasMore ? page.at(-1)!.position : highWater),
            filter,
          }),
          hasMore,
        };
      },
    },
    operations: {
      async list(graphId, options) {
        const { limit, filter, cursor } = operationReadOptions(
          options,
          graphId,
        );
        const before = (operation: Operation) =>
          !cursor ||
          operation.recordedAt < cursor.recordedAt ||
          (operation.recordedAt === cursor.recordedAt &&
            operation.id < cursor.id);
        const rows = [...(histories.get(graphId)?.rows.values() ?? [])]
          .map((row) => row.operation)
          .filter(before)
          .sort((a, b) =>
            a.recordedAt === b.recordedAt
              ? a.id < b.id
                ? 1
                : -1
              : a.recordedAt < b.recordedAt
                ? 1
                : -1,
          );
        const matches: Operation[] = [];
        let scanned: Operation | undefined;

        for (const operation of rows) {
          if (matches.length > limit) break;

          scanned = operation;

          if (matchesOperation(filter, operation)) matches.push(operation);
        }

        const hasMore = matches.length > limit;
        const page = matches.slice(0, limit);
        const last = hasMore ? page.at(-1)! : scanned;

        return {
          entries: structuredClone(page),
          nextCursor: encodeActivityCursor({
            method: 'operations',
            graphId,
            recordedAt:
              last?.recordedAt ?? cursor?.recordedAt ?? floor.recordedAt,
            id: last?.id ?? cursor?.id ?? floor.id,
            filter,
          }),
          hasMore,
        };
      },
    },
  };

  return { store, prepareFeed, limits };
}

export type MemoryActivity = ReturnType<typeof createMemoryActivity>;
