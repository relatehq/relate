import type { ActivityReader, FeedEntry, Operation } from '@relate/protocol';

/** Host-owned lifetime; activity owns polling, checkpoints and row selection. */
export function createActivityForwarder(options: {
  readonly activity: ActivityReader;
  readonly runtimeId: string;
  readonly send: (rows: {
    readonly feed: readonly FeedEntry[];
    readonly operations: readonly Operation[];
  }) => Promise<void>;
}) {
  const { activity, runtimeId, send } = options;
  /**
   * Forward the runtime's own records of this runtime's dev requests (rows
   * whose context names this `runtimeId`) to the dev server, which projects
   * them onto the activity log. Best effort and never part of a write: a missed
   * pass loses display rows only, and the store's feed stays authoritative.
   *
   * Passes run for about a second after each operation, because operation rows
   * are appended asynchronously after the call settles. The feed is read from
   * its checkpoint; operations newest first down to the previous pass's
   * watermark, since this runtime's single writer records them in order.
   */
  const forwarding = {
    enabled: false,
    /** Feed entries from before this host started are never ours. */
    feedFrom: '',
    feedCursor: undefined as string | undefined,
    /** Newest `recordedAt` seen (epoch ms), and the IDs seen at or after it. */
    since: 0,
    seen: new Map<string, number>(),
    pass: undefined as Promise<void> | undefined,
    remaining: 0,
    timer: undefined as NodeJS.Timeout | undefined,
  };

  const ours = (row: FeedEntry | Operation) =>
    row.context.runtimeId === runtimeId;

  async function forwardPass(): Promise<void> {
    const feed: FeedEntry[] = [];
    const operations: Operation[] = [];

    try {
      for (let more = true; more;) {
        const page = await activity.feed.read(
          forwarding.feedCursor
            ? { cursor: forwarding.feedCursor, limit: 200 }
            : { filter: { from: forwarding.feedFrom }, limit: 200 },
        );

        forwarding.feedCursor = page.nextCursor;
        more = page.hasMore;
        feed.push(...page.entries.filter(ours));
      }
    } catch (error) {
      // Eviction passed the checkpoint: resume from what is retained.
      if ((error as { code?: unknown }).code === 'cursor-expired')
        forwarding.feedCursor = undefined;
    }

    let newest = forwarding.since;
    let scanned = false;

    try {
      let cursor: string | undefined;

      scan: for (;;) {
        const page = await activity.operations.list(
          cursor ? { cursor, limit: 100 } : { limit: 100 },
        );

        for (const row of page.entries) {
          const at = Date.parse(row.recordedAt);

          if (at < forwarding.since) break scan;

          newest = Math.max(newest, at);

          if (forwarding.seen.has(row.id)) continue;

          forwarding.seen.set(row.id, at);

          if (ours(row)) operations.push(row);
        }

        if (!page.hasMore) break;

        cursor = page.nextCursor;
      }

      scanned = true;
    } catch {
      // Operation rows are best effort; the next pass resumes at the watermark.
    }

    // A partial scan keeps the old watermark so unread older rows are revisited;
    // `seen` already holds the rows forwarded from it.
    if (scanned) {
      forwarding.since = newest;

      for (const [id, at] of forwarding.seen)
        if (at < newest) forwarding.seen.delete(id);
    }

    if (feed.length || operations.length) await send({ feed, operations });
  }

  /** One pass at a time; `final` waits for a pass in flight, then runs one more. */
  function forwardActivity(final = false): Promise<void> {
    if (!forwarding.enabled) return Promise.resolve();

    const run = () =>
      (forwarding.pass ??= forwardPass()
        .catch(() => {})
        .finally(() => {
          forwarding.pass = undefined;
        }));

    return final ? (forwarding.pass ?? Promise.resolve()).then(run) : run();
  }

  /** Keep forwarding for about a second after the latest operation. */
  function scheduleForwarding(): void {
    if (!forwarding.enabled) return;

    forwarding.remaining = 10;
    forwarding.timer ??= setInterval(() => {
      void forwardActivity();

      if (--forwarding.remaining <= 0) {
        clearInterval(forwarding.timer);
        forwarding.timer = undefined;
      }
    }, 100);
    forwarding.timer.unref();
  }

  /**
   * Rows of earlier hosts (a seed, history in a persistent store) never name
   * this host's fresh `runtimeId`, so they are skipped, not forwarded. The
   * operation watermark starts at the newest existing row, in the store's clock.
   */
  async function startForwarding(): Promise<void> {
    // Feed entries carry this process's clock; the filter keeps the first pass
    // from paging through every retained entry of earlier hosts.
    forwarding.feedFrom = new Date().toISOString();

    try {
      if ((await activity.status()).state !== 'available') return;

      const [newest] = (await activity.operations.list({ limit: 1 })).entries;

      if (newest) {
        forwarding.since = Date.parse(newest.recordedAt);
        forwarding.seen.set(newest.id, forwarding.since);
      }

      forwarding.enabled = true;
    } catch {
      // Without readable activity the Inspector shows dispatch events only.
    }
  }

  return {
    start: startForwarding,
    schedule: scheduleForwarding,
    flush: () => forwardActivity(true),
  };
}
