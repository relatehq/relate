import type { ActivityStore, FeedDraft } from 'relate/storage';
import type { FeedEntry, Operation } from '@relate/protocol';
import {
  activityBytes,
  activityId,
  activityLimits,
  validateBatch,
} from './records.js';
import type { ActivityLimits } from './records.js';
import { activityPage, operationPosition } from './pages.js';

export function createMemoryActivity(config: ActivityLimits = {}) {
  const limits = { ...activityLimits, ...config };

  for (const n of Object.values(limits))
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error('Invalid activity limit');

  const graphs = new Map<
    string,
    {
      streamId: string;
      position: string;
      floor: string;
      operationsFloor: string;
      feed: FeedEntry[];
      operations: Operation[];
    }
  >();
  const state = (id: string) => {
    let s = graphs.get(id);

    if (!s) {
      s = {
        streamId: activityId(),
        position: '0',
        floor: '0',
        operationsFloor: '',
        feed: [],
        operations: [],
      };
      graphs.set(id, s);
    }

    return s;
  };
  const trim = <T>(rows: T[], onEvict: (row: T) => void) => {
    let bytes = rows.reduce((n, r) => n + activityBytes(r), 0);

    while (rows.length > limits.maxEntries || bytes > limits.maxBytes) {
      const row = rows.shift()!;

      bytes -= activityBytes(row);
      onEvict(row);
    }
  };
  const publish = (graphId: string, drafts: readonly FeedDraft[]) => {
    validateBatch(graphId, drafts, limits);
    const s = state(graphId),
      recordedAt = new Date().toISOString();
    const ids = new Set(s.feed.map((r) => r.id)),
      invocations = new Set(
        s.feed
          .filter((r) => 'actionDefinitionId' in r)
          .map((r) => r.invocationId),
      );
    const entries = drafts.map((draft, index) => {
      if (
        ids.has(draft.id) ||
        ('actionDefinitionId' in draft && invocations.has(draft.invocationId))
      )
        throw new Error('Duplicate feed identity');

      ids.add(draft.id);

      if ('actionDefinitionId' in draft) invocations.add(draft.invocationId);

      return {
        ...structuredClone(draft),
        recordedAt,
        position: String(BigInt(s.position) + BigInt(index + 1)),
      } as FeedEntry;
    });

    if (activityBytes(entries) > limits.maxBytes)
      throw new Error('Feed batch exceeds retention');

    s.feed.push(...entries);
    s.position = entries.at(-1)?.position ?? s.position;
    trim(s.feed, (row) => {
      s.floor = row.position;
    });
  };
  const store: ActivityStore = {
    async status() {
      return { state: 'available', durability: 'volatile' };
    },
    async appendOperations(graphId, drafts) {
      validateBatch(graphId, drafts, limits);
      const s = state(graphId),
        ids = new Set(s.operations.map((r) => r.id));
      const rows: Operation[] = [];

      for (const draft of drafts)
        if (!ids.has(draft.id)) {
          ids.add(draft.id);
          rows.push({
            ...structuredClone(draft),
            recordedAt: new Date().toISOString(),
          } as Operation);
        }

      s.operations.push(...rows);
      s.operations.sort((a, b) =>
        operationPosition(a).localeCompare(operationPosition(b)),
      );
      trim(s.operations, (row) => {
        s.operationsFloor = operationPosition(row);
      });
    },
    feed: {
      async read(graphId, options) {
        const s = state(graphId);

        return activityPage(graphId, 'feed', s, s.feed, options);
      },
    },
    operations: {
      async list(graphId, options) {
        const s = state(graphId);

        return activityPage(graphId, 'operations', s, s.operations, options);
      },
    },
  };

  return { store, publish };
}
