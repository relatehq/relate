import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { DatasetExecutionError } from 'relate/connectors';
import type { AnalyticalExecutionTiming } from 'relate/connectors';
import type { AnalyticalOperation, ChildResponse } from './messages.js';

/** Host-only diagnostics may contain physical names or driver details. */
export interface DuckDBDiagnostic {
  readonly kind: 'database' | 'startup' | 'timeout' | 'crash' | 'protocol';
  readonly message: string;
}

type Result = Extract<ChildResponse, { kind: 'result' }>['value'];

type Worker = {
  child: ChildProcess;
  ready: boolean;
  busy: boolean;
  closing: boolean;
  stderr: string;
  exited: Promise<void>;
  message?: ((message: ChildResponse) => void) | undefined;
  cancel?: ((reason: unknown) => void) | undefined;
  end?:
    ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
};

export function createProcessRunner(settings: {
  path: string;
  startupTimeoutMs: number;
  onDiagnostic?: (diagnostic: DuckDBDiagnostic) => void;
  /** Internal test seam for the worker protocol. Public connections always use child.js. */
  workerUrl?: URL;
}) {
  let closed = false;
  const workers = new Set<Worker>();
  const diagnostic = (kind: DuckDBDiagnostic['kind'], message: string) => {
    try {
      void Promise.resolve(settings.onDiagnostic?.({ kind, message })).catch(
        () => {},
      );
    } catch {
      /* Host observers cannot fail a read. */
    }
  };
  const failure = (
    kind: DuckDBDiagnostic['kind'],
    message: string,
    retryable = true,
  ) => {
    diagnostic(kind, message);

    return new DatasetExecutionError('execution-failed', {
      retryable,
      cause: new Error(message),
    });
  };

  function spawn(): Worker {
    const child = fork(
      settings.workerUrl ?? new URL('./child.js', import.meta.url),
      [],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        serialization: 'advanced',
        execArgv: [],
      },
    );
    let exited!: () => void;
    const worker: Worker = {
      child,
      ready: false,
      busy: false,
      closing: false,
      stderr: '',
      exited: new Promise((resolve) => {
        exited = resolve;
      }),
    };

    workers.add(worker);
    child.stderr!.on('data', (chunk: Buffer) => {
      worker.stderr = (worker.stderr + chunk.toString('utf8')).slice(-4096);
    });
    child.on('message', (message: ChildResponse) => {
      if (worker.message) worker.message(message);
      else if (!worker.closing) {
        diagnostic('protocol', 'Unexpected idle worker message');
        worker.closing = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      const reason = failure('crash', error.message);

      if (worker.cancel) worker.cancel(reason);
      else {
        worker.closing = true;
        child.kill('SIGKILL');
      }
    });
    child.on('close', (code, signal) => {
      if (!worker.end && !worker.closing)
        diagnostic(
          'crash',
          `Idle DuckDB worker exited (${signal ?? code}): ${worker.stderr || 'no stderr'}`,
        );

      workers.delete(worker);
      worker.closing = true;
      worker.end?.(code, signal);
      exited();
    });

    return worker;
  }

  function run(
    operation: AnalyticalOperation,
    options: {
      signal: AbortSignal;
      timeoutMs: number;
      onTiming?: (timing: AnalyticalExecutionTiming) => void;
    },
  ): Promise<Result> {
    options.signal.throwIfAborted();

    if (closed)
      return Promise.reject(
        failure('startup', 'DuckDB connection is closed', false),
      );

    let worker = [...workers].find((worker) => !worker.busy && !worker.closing);

    if (!worker && workers.size >= 4)
      return Promise.reject(
        failure('startup', 'DuckDB worker capacity exceeded'),
      );

    try {
      worker ??= spawn();
    } catch (cause) {
      return Promise.reject(
        failure(
          'startup',
          cause instanceof Error
            ? cause.message
            : 'Unable to start DuckDB worker',
        ),
      );
    }

    const owned = worker;

    owned.busy = true;
    owned.stderr = '';

    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      let failed = false;
      let reason: unknown;
      let phase: AnalyticalExecutionTiming['stage'] = owned.ready
        ? 'execution'
        : 'connectionStartup';
      let started = performance.now();
      let reported = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timing = () => {
        if (reported) return;

        reported = true;

        try {
          void Promise.resolve(
            options.onTiming?.({
              stage: phase,
              durationMs: Math.max(0, performance.now() - started),
            }),
          ).catch(() => {});
        } catch {
          /* Diagnostics never affect the statement. */
        }
      };
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        owned.message = undefined;
        owned.cancel = undefined;
        owned.end = undefined;
        owned.busy = false;
      };
      const fail = (error: unknown) => {
        if (settled || failed) return;

        failed = true;
        reason = error;
        clearTimeout(timer);
        owned.closing = true;
        owned.child.kill('SIGKILL');
      };
      const abort = () => fail(options.signal.reason);
      const send = (message: unknown) => {
        owned.child.send(message as object, (error) => {
          if (error && !settled) fail(failure('crash', error.message));
        });
      };
      const deadline = (ms: number) => {
        timer = setTimeout(
          () => fail(failure('timeout', `DuckDB ${phase} timed out`)),
          ms,
        );
      };

      owned.cancel = fail;
      owned.end = (code, signal) => {
        if (!failed)
          reason = failure(
            'crash',
            `DuckDB worker exited (${signal ?? code}): ${owned.stderr || 'no stderr'}`,
          );

        // Keep the operation cancellable while reporting its final timing.
        timing();
        cleanup();
        reject(options.signal.aborted ? options.signal.reason : reason);
      };
      owned.message = (message) => {
        if (failed || settled) return;

        if (!message || !['ready', 'result', 'failure'].includes(message.kind))
          return fail(
            failure('protocol', 'Invalid DuckDB worker response', false),
          );

        if (message.kind === 'ready') {
          if (phase !== 'connectionStartup')
            return fail(failure('protocol', 'Duplicate DuckDB startup', false));

          clearTimeout(timer);
          timing();

          if (failed) return;

          owned.ready = true;
          phase = 'execution';
          reported = false;
          started = performance.now();
          deadline(options.timeoutMs);
          send(operation);

          return;
        }

        // Statement deadline ends with its outcome, not with process retirement.
        clearTimeout(timer);

        if (phase === 'connectionStartup') {
          if (message.kind !== 'failure')
            return fail(
              failure('protocol', 'Result before DuckDB startup', false),
            );

          return fail(failure('startup', message.detail, message.retryable));
        }

        const error =
          message.kind === 'failure'
            ? new DatasetExecutionError(message.code, {
                retryable: message.retryable,
                cause: new Error(message.detail),
              })
            : undefined;

        if (message.kind === 'failure') diagnostic('database', message.detail);

        timing();

        if (failed) return;

        cleanup();

        if (error) reject(error);
        else if (message.kind === 'result') resolve(message.value);
      };
      options.signal.addEventListener('abort', abort, { once: true });

      if (options.signal.aborted) return abort();

      deadline(owned.ready ? options.timeoutMs : settings.startupTimeoutMs);
      send(owned.ready ? operation : { kind: 'open', path: settings.path });
    });
  }

  return {
    run,
    async close() {
      closed = true;
      const exiting = [...workers];

      for (const worker of exiting) {
        if (worker.cancel)
          worker.cancel(
            new DOMException(
              'DuckDB analytical connection retired',
              'AbortError',
            ),
          );
        else {
          worker.closing = true;
          worker.child.kill('SIGKILL');
        }
      }

      await Promise.all(exiting.map((worker) => worker.exited));
    },
  };
}
