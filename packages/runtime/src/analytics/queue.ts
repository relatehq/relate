/** A statement is admitted only while its configured connection has capacity. */
export interface StatementQueue {
  run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options: { signal: AbortSignal },
  ): Promise<T>;
  /** Stop admission, abort queued/running work, and wait for running resource cleanup. */
  retire(): Promise<void>;
}

export interface StatementQueueOptions {
  readonly concurrency?: number;
  readonly maxQueued?: number;
  readonly maxWaitMs?: number;
}

export class AnalyticalBusyError extends Error {
  readonly retryable = true;
  constructor(readonly reason: 'queue-full' | 'queue-timeout') {
    super('Analytical connection is busy');
    this.name = 'AnalyticalBusyError';
  }
}

interface Entry {
  start(): void;
  cancel(reason: unknown): void;
}

/** One instance per configured connection, shared by all actors and bindings. */
export function createStatementQueue(
  options: StatementQueueOptions = {},
): StatementQueue {
  const concurrency = options.concurrency ?? 4;
  const maxQueued = options.maxQueued ?? 32;
  const maxWaitMs = options.maxWaitMs ?? 2000;

  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    !Number.isSafeInteger(maxQueued) ||
    maxQueued < 0 ||
    !Number.isSafeInteger(maxWaitMs) ||
    maxWaitMs < 0 ||
    maxWaitMs > 2147483647
  )
    throw new Error('Invalid analytical queue limits');

  const pending: Entry[] = [];
  const active = new Set<Entry>();
  const retiredReason = new DOMException(
    'Analytical connection retired',
    'AbortError',
  );
  let retired = false;
  let retirement: Promise<void> | undefined;
  let drained: (() => void) | undefined;

  const pump = () => {
    while (!retired && active.size < concurrency && pending.length)
      pending.shift()!.start();

    if (retired && active.size === 0) drained?.();
  };

  return Object.freeze({
    run<T>(
      task: (signal: AbortSignal) => Promise<T>,
      { signal }: { signal: AbortSignal },
    ): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason);

      if (retired) return Promise.reject(retiredReason);

      if (active.size >= concurrency && pending.length >= maxQueued)
        return Promise.reject(new AnalyticalBusyError('queue-full'));

      if (active.size >= concurrency && maxWaitMs === 0)
        return Promise.reject(new AnalyticalBusyError('queue-timeout'));

      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let state: 'queued' | 'running' | 'settled' = 'queued';
        const stopWaiting = () => {
          if (timer !== undefined) clearTimeout(timer);

          timer = undefined;
        };
        const detach = () => {
          stopWaiting();
          signal.removeEventListener('abort', onAbort);
        };
        const finish = (
          result: { ok: true; value: T } | { ok: false; error: unknown },
        ) => {
          state = 'settled';
          detach();
          active.delete(entry);
          pump();

          if (controller.signal.aborted) reject(controller.signal.reason);
          else if (result.ok) resolve(result.value);
          else reject(result.error);
        };
        const entry: Entry = {
          start() {
            state = 'running';
            stopWaiting();
            active.add(entry);
            // Capture synchronous throws and cancellation before task startup too.
            void Promise.resolve()
              .then(() => {
                controller.signal.throwIfAborted();

                return task(controller.signal);
              })
              .then(
                (value) => finish({ ok: true, value }),
                (error: unknown) => finish({ ok: false, error }),
              );
          },
          cancel(reason) {
            if (state === 'settled') return;

            if (state === 'running') {
              // Capacity remains occupied until the task releases its resources.
              controller.abort(reason);

              return;
            }

            state = 'settled';
            detach();
            const index = pending.indexOf(entry);

            if (index !== -1) pending.splice(index, 1);

            reject(reason);
          },
        };
        const onAbort = () => entry.cancel(signal.reason);

        signal.addEventListener('abort', onAbort, { once: true });

        if (active.size < concurrency) entry.start();
        else {
          pending.push(entry);
          timer = setTimeout(
            () => entry.cancel(new AnalyticalBusyError('queue-timeout')),
            maxWaitMs,
          );
        }
      });
    },
    retire() {
      if (retirement) return retirement;

      retired = true;
      retirement = new Promise<void>((resolve) => {
        drained = resolve;
      });

      for (const entry of [...pending, ...active]) entry.cancel(retiredReason);

      pump();

      return retirement;
    },
  });
}
