import { fork } from 'node:child_process';
import { DatasetExecutionError } from 'relate/connectors';
import type { AnalyticalExecutionTiming } from 'relate/connectors';
import type { AnalyticalOperation, ChildResponse } from './messages.js';

export function createProcessRunner(settings: {
  path: string;
  busyTimeoutMs: number;
  startupTimeoutMs: number;
}) {
  let closed = false;
  const active = new Map<AbortController, Promise<unknown>>();

  function run(
    operation: AnalyticalOperation,
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      onTiming?: (timing: AnalyticalExecutionTiming) => void;
    },
  ): Promise<Extract<ChildResponse, { kind: 'result' }>['value']> {
    if (options.signal.aborted) return Promise.reject(options.signal.reason);

    if (closed)
      return Promise.reject(
        new DatasetExecutionError('execution-failed', { retryable: false }),
      );

    if (active.size >= 4)
      return Promise.reject(
        new DatasetExecutionError('execution-failed', { retryable: true }),
      );

    const controller = new AbortController();
    const task = new Promise<
      Extract<ChildResponse, { kind: 'result' }>['value']
    >((resolve, reject) => {
      let phase: AnalyticalExecutionTiming['stage'] | undefined =
        'connectionStartup';
      let started = performance.now();
      let outcome: Exclude<ChildResponse, { kind: 'ready' }> | undefined;
      let failure: unknown;
      let failed = false;
      let timer: ReturnType<typeof setTimeout>;
      const timing = () => {
        if (!phase) return;

        const stage = phase;

        phase = undefined;
        const durationMs = Math.max(0, performance.now() - started);

        try {
          if (options.onTiming)
            void Promise.resolve(options.onTiming({ stage, durationMs })).catch(
              () => {},
            );
        } catch {
          /* Diagnostics never affect the statement. */
        }
      };
      let child: ReturnType<typeof fork>;

      try {
        child = fork(new URL('./child.js', import.meta.url), [], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced',
          execArgv: [],
        });
      } catch (cause) {
        timing();
        reject(
          new DatasetExecutionError('execution-failed', {
            retryable: true,
            cause,
          }),
        );

        return;
      }

      const fail = (error: unknown) => {
        if (failed) return;

        failed = true;
        failure = error;
        child.kill('SIGKILL');
      };
      const abort = () => fail(options.signal.reason);
      const retire = () => fail(controller.signal.reason);

      options.signal.addEventListener('abort', abort, { once: true });
      controller.signal.addEventListener('abort', retire, { once: true });
      timer = setTimeout(
        () =>
          fail(
            new DatasetExecutionError('execution-failed', { retryable: true }),
          ),
        settings.startupTimeoutMs,
      );
      child.on('error', (error) =>
        fail(
          new DatasetExecutionError('execution-failed', {
            retryable: true,
            cause: error,
          }),
        ),
      );
      child.on('message', (message: ChildResponse) => {
        if (failed) return;

        if (
          !message ||
          typeof message !== 'object' ||
          !['ready', 'result', 'failure'].includes(message.kind) ||
          outcome ||
          (message.kind === 'result' && phase !== 'execution')
        )
          return fail(
            new DatasetExecutionError('invalid-result', { retryable: false }),
          );

        if (message.kind === 'ready') {
          if (phase !== 'connectionStartup')
            return fail(
              new DatasetExecutionError('invalid-result', { retryable: false }),
            );

          clearTimeout(timer);
          timing();

          if (failed) return;

          phase = 'execution';
          started = performance.now();
          timer = setTimeout(
            () =>
              fail(
                new DatasetExecutionError('execution-failed', {
                  retryable: false,
                }),
              ),
            options.timeoutMs,
          );
          child.send(operation, (error) => {
            if (error)
              fail(
                new DatasetExecutionError('execution-failed', {
                  retryable: true,
                  cause: error,
                }),
              );
          });
        } else outcome = message;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', retire);
        timing();

        if (failed) reject(failure);
        else if (options.signal.aborted) reject(options.signal.reason);
        else if (controller.signal.aborted) reject(controller.signal.reason);
        else if (outcome?.kind === 'failure')
          reject(
            new DatasetExecutionError(outcome.code, {
              retryable: outcome.retryable,
            }),
          );
        else if (code !== 0 || outcome?.kind !== 'result')
          reject(
            new DatasetExecutionError('execution-failed', { retryable: true }),
          );
        else resolve(outcome.value);
      });
      child.send(
        {
          kind: 'open',
          path: settings.path,
          busyTimeoutMs: settings.busyTimeoutMs,
          lifetimeMs: Math.min(
            2147483647,
            settings.startupTimeoutMs + options.timeoutMs,
          ),
        },
        (error) => {
          if (error)
            fail(
              new DatasetExecutionError('execution-failed', {
                retryable: true,
                cause: error,
              }),
            );
        },
      );
    });

    active.set(controller, task);
    void task.then(
      () => active.delete(controller),
      () => active.delete(controller),
    );

    return task;
  }

  return {
    run,
    async close() {
      closed = true;

      for (const controller of active.keys())
        controller.abort(
          new DOMException(
            'SQLite analytical connection retired',
            'AbortError',
          ),
        );

      await Promise.allSettled([...active.values()]);
    },
  };
}
