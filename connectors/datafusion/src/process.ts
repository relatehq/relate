import { spawn } from 'node:child_process';
import { DatasetExecutionError } from 'relate/connectors';
import type { AnalyticalExecutionTiming } from 'relate/connectors';

export interface DataFusionDiagnostic {
  readonly kind: 'engine' | 'timeout' | 'protocol' | 'process';
  readonly message: string;
}

/** One statement per process. Every promise settles only after the child closes. */
export function createRunner(settings: {
  executable: string;
  startupTimeoutMs: number;
  onDiagnostic?: (diagnostic: DataFusionDiagnostic) => void;
}) {
  let closed = false;
  const active = new Set<{
    cancel(reason: unknown): void;
    done: Promise<void>;
  }>();
  const failure = (
    kind: DataFusionDiagnostic['kind'],
    message: string,
    retryable = true,
  ) => {
    try {
      void Promise.resolve(settings.onDiagnostic?.({ kind, message })).catch(
        () => {},
      );
    } catch {
      /* observer */
    }

    return new DatasetExecutionError('execution-failed', {
      retryable,
      cause: new Error(message),
    });
  };

  return {
    run(
      request: unknown,
      options: {
        signal: AbortSignal;
        timeoutMs: number;
        onTiming?: (timing: AnalyticalExecutionTiming) => void;
      },
    ): Promise<{ value: unknown; readAt: string }> {
      options.signal.throwIfAborted();

      if (closed)
        return Promise.reject(
          failure('process', 'DataFusion connection is closed', false),
        );

      if (active.size >= 4)
        return Promise.reject(
          failure('process', 'DataFusion worker capacity exceeded'),
        );

      const serialized = JSON.stringify(request);

      if (Buffer.byteLength(serialized) > 8 * 1024 * 1024)
        return Promise.reject(
          failure('protocol', 'DataFusion request exceeds 8 MiB', false),
        );

      return new Promise((resolve, reject) => {
        const child = spawn(settings.executable, [], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buffer = '';
        let bytes = 0;
        let stderr = '';
        let reason: unknown;
        let failed = false;
        let result: unknown;
        let received = false;
        let readAt = '';
        let phase: AnalyticalExecutionTiming['stage'] = 'connectionStartup';
        let started = performance.now();
        let reported = false;
        let timer: ReturnType<typeof setTimeout>;
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const cancel = (error: unknown) => {
          if (failed) return;

          failed = true;
          reason = error;
          child.kill('SIGKILL');
        };
        const entry = { cancel, done };

        active.add(entry);
        const abort = () => cancel(options.signal.reason);
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
            /* observer */
          }
        };
        const deadline = (ms: number) =>
          setTimeout(
            () => cancel(failure('timeout', `DataFusion ${phase} timed out`)),
            ms,
          );

        timer = deadline(settings.startupTimeoutMs);
        options.signal.addEventListener('abort', abort, { once: true });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-4096);
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (failed) return;

          bytes += Buffer.byteLength(chunk);

          if (bytes > 16 * 1024 * 1024)
            return cancel(
              failure('protocol', 'DataFusion response exceeds 16 MiB', false),
            );

          buffer += chunk;
          let end: number;

          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);

            buffer = buffer.slice(end + 1);

            try {
              const message = JSON.parse(line) as {
                kind?: string;
                value?: unknown;
                detail?: unknown;
              };

              if (received) throw new Error('Duplicate DataFusion result');

              if (message.kind === 'ready' && phase === 'connectionStartup') {
                clearTimeout(timer);
                timing();

                if (failed) return;

                phase = 'execution';
                reported = false;
                readAt = new Date().toISOString();
                started = performance.now();
                timer = deadline(options.timeoutMs);
              } else if (message.kind === 'result' && phase === 'execution') {
                received = true;
                result = message.value;
                // Release the native stdin watcher so normal shutdown can join it.
                child.stdin.end();
                // Keep the deadline active through native teardown.
              } else if (
                message.kind === 'failure' &&
                typeof message.detail === 'string'
              ) {
                cancel(failure('engine', message.detail.slice(0, 4096), false));
              } else throw new Error('Invalid DataFusion protocol');
            } catch (error) {
              cancel(
                failure(
                  'protocol',
                  error instanceof Error
                    ? error.message
                    : 'Invalid DataFusion protocol',
                  false,
                ),
              );
            }
          }
        });
        child.on('error', (error) => cancel(failure('process', error.message)));
        child.stdin.on('error', (error) =>
          cancel(failure('process', error.message)),
        );
        child.on('close', (code) => {
          clearTimeout(timer);
          timing();
          options.signal.removeEventListener('abort', abort);
          active.delete(entry);
          finish();

          if (options.signal.aborted) reject(options.signal.reason);
          else if (failed) reject(reason);
          else if (code !== 0 || !received || buffer.trim())
            reject(
              failure(
                'process',
                `DataFusion exited without a complete response: ${stderr || code}`,
              ),
            );
          else resolve({ value: result, readAt });
        });

        if (options.signal.aborted) abort();
        else child.stdin.write(serialized + '\n');
      });
    },
    async close() {
      closed = true;
      const pending = [...active];

      for (const entry of pending)
        entry.cancel(
          new DOMException('DataFusion connection retired', 'AbortError'),
        );

      await Promise.all(pending.map((entry) => entry.done));
    },
  };
}
