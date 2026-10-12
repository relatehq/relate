import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnvironment, killExecution } from './process-lifecycle.js';
import { StringDecoder } from 'node:string_decoder';
import type { Json } from '@relate/protocol';
import { snapshotBinding } from './binding.js';
import type {
  CodeExecutor,
  ExecutionError,
  ExecutionLog,
  ExecutionResult,
} from './executor.js';
import { operationError, operationNames } from './wire.js';
import type { Operation } from './wire.js';

export interface DevelopmentExecutorOptions {
  /** Whole execution, including startup and graph calls. Default: 10 seconds. */
  timeoutMs?: number;
  /** Combined stdout, stderr and JSON result/error bytes. Default: 1 MiB. */
  maxOutputBytes?: number;
}

/** Fresh Node process, NOT a security sandbox. Run trusted development code only. */
export function createDevelopmentExecutor(
  options: DevelopmentExecutorOptions = {},
): CodeExecutor {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;

  for (const [name, value] of Object.entries({ timeoutMs, maxOutputBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2 ** 31 - 1)
      throw new RangeError(`${name} must be a positive integer <= 2147483647`);
  }

  return {
    async execute({ code, graph, signal }) {
      const logs: ExecutionLog[] = [];
      const fail = (code: string, message: string): ExecutionResult => ({
        status: 'failed',
        logs,
        error: { name: 'ExecutionError', code, message },
      });

      if (signal?.aborted) return fail('aborted', 'Execution aborted');

      let snapshot;

      try {
        snapshot = snapshotBinding(graph);
      } catch {
        return fail('binding', 'Graph binding is invalid or unavailable');
      }

      const directory = await mkdtemp(join(tmpdir(), 'relate-mcp-'));

      try {
        if (signal?.aborted) return fail('aborted', 'Execution aborted');

        return await new Promise<ExecutionResult>((resolve) => {
          const child = fork(
            new URL('./child.js', import.meta.url),
            [String(process.pid)],
            {
              cwd: directory,
              // Do not inherit loaders, debugger flags, NODE_OPTIONS or host credentials.
              execArgv: [],
              env: childEnvironment(directory),
              serialization: 'advanced',
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
              detached: process.platform !== 'win32',
            },
          );
          let bytes = 0;
          let stopping = false;
          let pending = 0;
          let completion: ExecutionResult | undefined;
          let result: ExecutionResult | undefined;
          const decoders = {
            stdout: new StringDecoder('utf8'),
            stderr: new StringDecoder('utf8'),
          };
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          let finished = false;
          const kill = () => {
            if (child.pid) killExecution(child.pid);
          };
          const finish = () => {
            if (finished) return;

            finished = true;
            stopping = true;
            clearTimeout(timer);
            clearTimeout(cleanupTimer);
            signal?.removeEventListener('abort', abort);
            child.stdout!.destroy();
            child.stderr!.destroy();

            if (child.connected) child.disconnect();

            for (const stream of ['stdout', 'stderr'] as const) {
              const text = decoders[stream].end();

              if (text && bytes < maxOutputBytes) logs.push({ stream, text });
            }

            resolve(
              result ??
                fail('process', 'Execution subprocess exited without a result'),
            );
          };
          const stop = (outcome: ExecutionResult) => {
            if (stopping) return;

            stopping = true;
            result = outcome;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            kill();
            // An escaped grandchild can keep the pipes open after child exit.
            // Drain ordinary buffered output, but never wait for EOF indefinitely.
            cleanupTimer = setTimeout(finish, 250);
          };
          const abort = () => stop(fail('aborted', 'Execution aborted'));
          const timer = setTimeout(
            () => stop(fail('timeout', `Execution exceeded ${timeoutMs}ms`)),
            timeoutMs,
          );
          const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
            const remaining = Math.max(0, maxOutputBytes - bytes);

            bytes += chunk.length;
            const text = decoders[stream].write(chunk.subarray(0, remaining));

            if (text) logs.push({ stream, text });

            if (bytes > maxOutputBytes) {
              const exceeded = fail(
                'output-limit',
                'Execution output limit exceeded',
              );

              // Output already in the pipe still counts after a success message.
              if (stopping && result?.status === 'succeeded') result = exceeded;
              else stop(exceeded);
            }
          };

          child.stdout!.on('data', (chunk: Buffer) => capture('stdout', chunk));
          child.stderr!.on('data', (chunk: Buffer) => capture('stderr', chunk));
          child.on('error', () =>
            stop(fail('process', 'Execution subprocess failed')),
          );
          child.once('exit', () =>
            stop(
              result ??
                fail('process', 'Execution subprocess exited without a result'),
            ),
          );
          child.once('close', finish);
          const send = (message: object) => {
            if (!stopping && child.connected)
              child.send(message, (error) => {
                if (error) stop(fail('process', 'Execution IPC failed'));
              });
          };

          child.on('message', (raw: unknown) => {
            if (stopping || !raw || typeof raw !== 'object') return;

            const message = raw as {
              type: string;
              id: number;
              operation: Operation;
              args: unknown[];
              encoded: string;
            };

            if (message.type === 'result' || message.type === 'failed') {
              if (completion) return;

              const encoded = message.encoded;

              if (typeof encoded !== 'string') {
                stop(fail('protocol', 'Invalid execution IPC message'));

                return;
              }

              bytes += Buffer.byteLength(encoded);

              if (bytes > maxOutputBytes) {
                stop(fail('output-limit', 'Execution output limit exceeded'));

                return;
              }

              let value: Json;

              try {
                value = JSON.parse(encoded) as Json;
              } catch {
                stop(fail('protocol', 'Invalid execution IPC message'));

                return;
              }

              const error = value as unknown as ExecutionError;

              if (
                message.type === 'failed' &&
                (!error ||
                  typeof error.name !== 'string' ||
                  typeof error.message !== 'string' ||
                  (error.code !== undefined && typeof error.code !== 'string'))
              ) {
                stop(fail('protocol', 'Invalid execution IPC message'));

                return;
              }

              completion =
                message.type === 'result'
                  ? { status: 'succeeded', result: value, logs }
                  : { status: 'failed', error, logs };

              // Account for already-dispatched calls even if JS forgot to await them.
              if (pending === 0) stop(completion);

              return;
            }

            if (message.type !== 'operation' || completion) return;

            if (
              !Number.isSafeInteger(message.id) ||
              !operationNames.includes(message.operation) ||
              !Array.isArray(message.args)
            ) {
              stop(fail('protocol', 'Invalid execution IPC message'));

              return;
            }

            if (pending >= 64) {
              stop(
                fail('operation-limit', 'Too many concurrent graph operations'),
              );

              return;
            }

            pending++;
            void (async () => {
              try {
                // ConsumerOperations owns per-call model pinning and authorization.
                // Only these five actor-bound public operations can be dispatched.
                const operation = graph.operations[message.operation] as (
                  ...args: unknown[]
                ) => Promise<unknown>;
                const value = await operation.apply(
                  graph.operations,
                  message.args,
                );

                send({ type: 'reply', id: message.id, value });
              } catch (error) {
                send({
                  type: 'reply',
                  id: message.id,
                  error: operationError(error),
                });
              } finally {
                pending--;

                if (completion && pending === 0) stop(completion);
              }
            })();
          });
          signal?.addEventListener('abort', abort, { once: true });

          if (signal?.aborted) abort();
          else send({ type: 'start', code, snapshot, maxOutputBytes });
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
