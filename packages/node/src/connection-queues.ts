import { createStatementQueue } from '@relate/runtime';
import type { StatementQueue, StatementQueueOptions } from '@relate/runtime';

// Shared across host generations that borrow the same configured connection.
const connectionQueues = new WeakMap<
  object,
  { options: string; queue: StatementQueue; leases: number }
>();

export function leaseConnectionQueue(
  connection: object,
  options: StatementQueueOptions,
  capacity?: number,
): StatementQueue {
  const resolved = {
    concurrency: Math.min(options.concurrency ?? 4, capacity ?? Infinity),
    maxQueued: options.maxQueued ?? 32,
    maxWaitMs: options.maxWaitMs ?? 2000,
  };
  const key = JSON.stringify(resolved);
  let entry = connectionQueues.get(connection);

  if (entry && entry.options !== key)
    throw new Error(
      'Runtimes sharing an analytical connection must use the same queue limits',
    );

  if (!entry) {
    entry = { options: key, queue: createStatementQueue(resolved), leases: 0 };
    connectionQueues.set(connection, entry);
  }

  const owned = entry;

  owned.leases++;
  let retirement: Promise<void> | undefined;
  const shared = entry.queue;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();

  return {
    run(task, options) {
      const result = shared.run(task, {
        ...options,
        signal: AbortSignal.any([lifetime.signal, options.signal]),
      });

      pending.add(result);
      void result.finally(() => pending.delete(result)).catch(() => {});

      return result;
    },
    retire() {
      return (retirement ??= (async () => {
        lifetime.abort(
          new DOMException('Analytical connection retired', 'AbortError'),
        );
        await Promise.allSettled(pending);

        if (--owned.leases === 0) connectionQueues.delete(connection);
      })());
    },
  };
}
