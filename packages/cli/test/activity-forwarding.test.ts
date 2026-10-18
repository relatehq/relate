import { expect, it } from 'vitest';
import { ActivityError } from '@relate/protocol';
import type {
  ActivityReader,
  ActivityStatus,
  FeedEntry,
  Operation,
} from '@relate/protocol';
import { createActivityForwarder } from '../src/dev/activity/forwarding.js';

const runtimeId = 'runtime-1';

/** Only the fields forwarding selects on; the rows are otherwise opaque here. */
function operation(id: string, at: number, runtime = runtimeId): Operation {
  return {
    id,
    recordedAt: new Date(at).toISOString(),
    context: { requestId: id, transport: 'embedded', runtimeId: runtime },
  } as unknown as Operation;
}

function entry(id: string, at: number, runtime = runtimeId): FeedEntry {
  return {
    id,
    occurredAt: new Date(at).toISOString(),
    context: { requestId: id, transport: 'embedded', runtimeId: runtime },
  } as unknown as FeedEntry;
}

/** A store-shaped reader: feed oldest first, operations newest first, offset cursors. */
function createReader(
  status: ActivityStatus = {
    state: 'available',
    durability: 'volatile',
    operationCapture: 'enabled',
  },
) {
  const feed: FeedEntry[] = [];
  const operations: Operation[] = [];
  const failures = { feedCursor: 0, operationsPage: 0 };
  const reader: ActivityReader = {
    status: async () => status,
    feed: {
      async read(options = {}) {
        const limit = options.limit ?? 100;
        let start: number;

        if (options.cursor !== undefined) {
          if (failures.feedCursor > 0) {
            failures.feedCursor--;
            throw new ActivityError('cursor-expired');
          }

          start = Number(options.cursor);
        } else {
          const from = options.filter?.from ?? '';

          start = feed.findIndex((row) => row.occurredAt >= from);

          if (start < 0) start = feed.length;
        }

        const entries = feed.slice(start, start + limit);
        const next = start + entries.length;

        return {
          entries,
          nextCursor: String(next),
          hasMore: next < feed.length,
        };
      },
    },
    operations: {
      async list(options = {}) {
        const limit = options.limit ?? 100;
        const start = options.cursor === undefined ? 0 : Number(options.cursor);

        if (start > 0 && failures.operationsPage > 0) {
          failures.operationsPage--;
          throw new Error('store unavailable');
        }

        const newestFirst = [...operations].reverse();
        const entries = newestFirst.slice(start, start + limit);
        const next = start + entries.length;

        return {
          entries,
          nextCursor: String(next),
          hasMore: next < newestFirst.length,
        };
      },
    },
  };

  return { reader, feed, operations, failures };
}

function createForwarder(reader: ActivityReader) {
  const sent: { feed: string[]; operations: string[] }[] = [];
  const forwarder = createActivityForwarder({
    activity: reader,
    runtimeId,
    send: async (rows) => {
      sent.push({
        feed: rows.feed.map((row) => row.id),
        operations: rows.operations.map((row) => row.id),
      });
    },
  });

  return { forwarder, sent };
}

it('forwards only this runtime’s new rows, once each, across passes', async () => {
  const { reader, feed, operations } = createReader();
  const now = Date.now();

  operations.push(operation('earlier-host', now - 60_000, 'runtime-0'));
  feed.push(entry('earlier-feed', now - 60_000, 'runtime-0'));
  const { forwarder, sent } = createForwarder(reader);

  await forwarder.start();
  operations.push(
    operation('ours-1', now + 1_000),
    operation('other-runtime', now + 1_000, 'runtime-2'),
  );
  feed.push(
    entry('feed-ours', now + 1_000),
    entry('feed-other', now + 1_000, 'runtime-2'),
  );
  await forwarder.flush();
  // A later row and one recorded afterwards in the same millisecond.
  operations.push(operation('ours-2', now + 2_000));
  await forwarder.flush();
  operations.push(operation('ours-3', now + 2_000));
  await forwarder.flush();
  await forwarder.flush();

  expect(sent).toEqual([
    { feed: ['feed-ours'], operations: ['ours-1'] },
    { feed: [], operations: ['ours-2'] },
    { feed: [], operations: ['ours-3'] },
  ]);
});

it('revisits older operation rows after a partial scan without repeating any', async () => {
  const { reader, operations, failures } = createReader();
  const { forwarder, sent } = createForwarder(reader);
  const now = Date.now();

  await forwarder.start();

  for (let index = 0; index < 150; index++)
    operations.push(operation(`op-${index}`, now + index));

  failures.operationsPage = 1;
  await forwarder.flush();
  await forwarder.flush();

  const forwarded = sent.flatMap((rows) => rows.operations);

  expect(sent.map((rows) => rows.operations.length)).toEqual([100, 50]);
  expect(new Set(forwarded).size).toBe(150);
});

it('resumes the feed from retained history after its checkpoint expires', async () => {
  const { reader, feed, failures } = createReader();
  const { forwarder, sent } = createForwarder(reader);
  const now = Date.now();

  await forwarder.start();
  feed.push(entry('feed-1', now + 1_000));
  await forwarder.flush();
  feed.push(entry('feed-2', now + 2_000));
  failures.feedCursor = 1;
  await forwarder.flush();
  await forwarder.flush();

  expect(sent.map((rows) => rows.feed)).toEqual([
    ['feed-1'],
    // Restarting from the host's start re-reads what is retained; the
    // projection merges rows by ID.
    ['feed-1', 'feed-2'],
  ]);
});

it('flush waits for a pass in flight, then runs one more', async () => {
  const { reader, operations } = createReader();
  const now = Date.now();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const sent: string[][] = [];
  const forwarder = createActivityForwarder({
    activity: reader,
    runtimeId,
    send: async (rows) => {
      sent.push(rows.operations.map((row) => row.id));

      if (sent.length === 1) await gate;
    },
  });

  await forwarder.start();
  operations.push(operation('first', now + 1_000));
  const inFlight = forwarder.flush();

  await expect.poll(() => sent.length).toBe(1);
  // Recorded after the in-flight pass scanned.
  operations.push(operation('second', now + 2_000));
  const final = forwarder.flush();

  release();
  await Promise.all([inFlight, final]);

  expect(sent).toEqual([['first'], ['second']]);
});

it('stays idle when the store cannot read activity', async () => {
  const { reader, operations } = createReader({ state: 'unsupported' });
  const { forwarder, sent } = createForwarder(reader);

  await forwarder.start();
  operations.push(operation('ours', Date.now() + 1_000));
  forwarder.schedule();
  await forwarder.flush();

  expect(sent).toEqual([]);
});
