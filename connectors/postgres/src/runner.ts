import { DatasetExecutionError } from 'relate/connectors';
import type { AnalyticalExecutionTiming } from 'relate/connectors';
import { createClientFactory } from './client.js';
import type { ClientFactory, StatementClient } from './client.js';

export function createRunner(
  settings: {
    url: string;
    startupTimeoutMs: number;
    cancelTimeoutMs: number;
  },
  factory: ClientFactory = createClientFactory(settings),
) {
  const active = new Map<AbortController, Promise<unknown>>();
  let closed = false;
  const failure = (cause?: unknown) =>
    new DatasetExecutionError('execution-failed', {
      retryable: true,
      ...(cause === undefined ? {} : { cause }),
    });

  async function cancel(pid: number): Promise<boolean> {
    const control = factory('control');
    const timer = setTimeout(() => control.destroy(), settings.cancelTimeoutMs);

    try {
      await control.connect();
      const rows = await control.query(
        'SELECT pg_catalog.pg_cancel_backend($1::pg_catalog.int4)',
        [pid],
      );

      return rows[0]?.[0] === 't';
    } catch {
      return false;
    } finally {
      try {
        await control.end();
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function perform<T>(
    controller: AbortController,
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      onTiming?: (timing: AnalyticalExecutionTiming) => void;
    },
    execute: (client: StatementClient, readAt: string) => Promise<T>,
  ): Promise<T> {
    let phase: AnalyticalExecutionTiming['stage'] | undefined =
      'connectionStartup';
    let started = performance.now();
    const report = () => {
      if (!phase) return;

      const stage = phase;

      phase = undefined;

      try {
        void Promise.resolve(
          options.onTiming?.({
            stage,
            durationMs: Math.max(0, performance.now() - started),
          }),
        ).catch(() => {});
      } catch {
        /* Diagnostics cannot alter execution. */
      }
    };
    let client: StatementClient;

    try {
      client = factory('statement');
    } catch (cause) {
      report();
      throw failure(cause);
    }

    let pid: number | undefined;
    let cancellation: Promise<void> | undefined;
    let ending: Promise<void> | undefined;
    let statement: Promise<T> | undefined;
    let executionStarted = false;
    const end = () => (ending ??= client.end());
    const abort = () => {
      if (cancellation) return;

      cancellation = (async () => {
        if (executionStarted && pid !== undefined) {
          const acknowledged = await cancel(pid).catch(() => false);

          // If control access fails, keep capacity until the primary receives its
          // server timeout/result. The watchdog bounds a lost primary connection.
          if (!acknowledged && statement) await statement.catch(() => {});
        } else client.destroy();

        await end();
      })().catch(() => {});
    };
    const relay = () => controller.abort(options.signal.reason);

    options.signal.addEventListener('abort', relay, { once: true });
    controller.signal.addEventListener('abort', abort, { once: true });
    let timer = setTimeout(
      () => controller.abort(failure()),
      settings.startupTimeoutMs,
    );
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    try {
      if (options.signal.aborted) relay();

      controller.signal.throwIfAborted();
      await client.connect();
      controller.signal.throwIfAborted();
      await client.query('BEGIN READ ONLY');
      const identity = await client.query('SELECT pg_catalog.pg_backend_pid()');

      pid = Number(identity[0]?.[0]);

      if (!Number.isSafeInteger(pid) || pid < 1) throw failure();

      await client.query(
        "SELECT pg_catalog.set_config('statement_timeout', $1::pg_catalog.text, true)",
        [String(options.timeoutMs)],
      );

      controller.signal.throwIfAborted();
      clearTimeout(timer);
      report();
      controller.signal.throwIfAborted();
      phase = 'execution';
      started = performance.now();
      executionStarted = true;
      timer = setTimeout(() => controller.abort(failure()), options.timeoutMs);
      watchdog = setTimeout(() => {
        controller.abort(failure());
        client.destroy();
      }, options.timeoutMs + settings.cancelTimeoutMs);
      statement = execute(client, new Date().toISOString());
      const result = await statement;

      controller.signal.throwIfAborted();
      await client.query('ROLLBACK');
      controller.signal.throwIfAborted();

      return result;
    } catch (cause) {
      if (controller.signal.aborted) throw controller.signal.reason;

      if (cause instanceof DatasetExecutionError) throw cause;

      const code = (cause as { code?: unknown })?.code;

      throw new DatasetExecutionError('execution-failed', {
        retryable:
          typeof code === 'string' &&
          (/^(08|53|57|40001|40P01)/.test(code) ||
            [
              'ECONNRESET',
              'ECONNREFUSED',
              'ETIMEDOUT',
              'EPIPE',
              'ENOTFOUND',
              'EAI_AGAIN',
            ].includes(code)),
        cause,
      });
    } finally {
      try {
        if (cancellation) await cancellation;

        await end();

        if (cancellation) await cancellation;
      } finally {
        clearTimeout(timer);

        if (watchdog !== undefined) clearTimeout(watchdog);

        options.signal.removeEventListener('abort', relay);
        controller.signal.removeEventListener('abort', abort);
        report();
      }
    }
  }

  return {
    run<T>(
      execute: (client: StatementClient, readAt: string) => Promise<T>,
      options: {
        signal: AbortSignal;
        timeoutMs: number;
        onTiming?: (timing: AnalyticalExecutionTiming) => void;
      },
    ): Promise<T> {
      options.signal.throwIfAborted();

      if (closed)
        return Promise.reject(
          new DatasetExecutionError('execution-failed', { retryable: false }),
        );

      if (active.size >= 4) return Promise.reject(failure());

      const controller = new AbortController();
      const task = perform(controller, options, execute)
        .then((result) => {
          // Abort during rollback/client shutdown must also prevent publication.
          options.signal.throwIfAborted();
          controller.signal.throwIfAborted();

          return result;
        })
        .catch((cause) => {
          if (options.signal.aborted) throw options.signal.reason;

          if (controller.signal.aborted) throw controller.signal.reason;

          if (cause instanceof DatasetExecutionError) throw cause;

          throw failure(cause);
        });

      active.set(controller, task);
      void task.finally(() => active.delete(controller)).catch(() => {});

      return task;
    },
    async close() {
      closed = true;

      for (const controller of active.keys()) controller.abort(failure());

      await Promise.allSettled(active.values());
    },
  };
}
