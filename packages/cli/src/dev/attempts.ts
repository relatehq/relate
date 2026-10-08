/**
 * Build attempts: bundle, spawn a fresh application child, enforce the
 * evaluation deadline and classify the outcome. Only the newest attempt may
 * report; superseded ones are cancelled silently.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from 'relate/model';
import type { SourceSite } from 'relate/diagnostics';
import type { Diagnostic } from '@relate/inspector/protocol';
import type { Builder } from './build.js';
import { LinePrefixer, streamPrefix } from './streams.js';
import {
  encodeWorkerArguments,
  workerMessageSchema,
} from './worker-protocol.js';

export type AttemptOutcome =
  | {
      readonly kind: 'model';
      readonly attempt: number;
      readonly manifest: Manifest;
      readonly definitionRevision: string;
      readonly sites: Readonly<Record<string, SourceSite>>;
      readonly inputs: readonly string[];
      readonly durationMs: number;
    }
  | {
      readonly kind: 'failure';
      readonly attempt: number;
      readonly diagnostics: readonly Diagnostic[];
      readonly inputs: readonly string[];
      readonly durationMs: number;
    }
  | { readonly kind: 'cancelled'; readonly attempt: number };

export interface AttemptRunnerOptions {
  readonly builder: Builder;
  readonly projectRoot: string;
  readonly configPath: string;
  readonly evalTimeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (line: string) => void;
  readonly isStdoutSaturated?: () => boolean;
  readonly isStderrSaturated?: () => boolean;
  readonly workerPath?: string;
  /** Grace before forcing a terminated child, in milliseconds. */
  readonly killGraceMs?: number;
}

export interface AttemptRunner {
  /** Start a new attempt, cancelling any running one. Resolves with its outcome. */
  start(): Promise<AttemptOutcome>;
  /** Stop everything; owned children get the grace period, then SIGKILL. */
  stop(options?: { readonly immediate?: boolean }): Promise<void>;
  readonly currentAttempt: number;
}

interface Handle {
  readonly attempt: number;
  child: ChildProcess | null;
  cancelled: boolean;
}

export function defaultWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'worker.js');
}

function terminate(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, graceMs);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

export function createAttemptRunner(
  options: AttemptRunnerOptions,
): AttemptRunner {
  const workerPath = options.workerPath ?? defaultWorkerPath();
  const killGraceMs = options.killGraceMs ?? 2_000;
  let counter = 0;
  let active: Handle | null = null;
  const children = new Set<ChildProcess>();
  const run = async (handle: Handle): Promise<AttemptOutcome> => {
    const { attempt } = handle;
    const cancelled = () => handle.cancelled;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const build = await options.builder.build(attempt);

    if (cancelled()) {
      if (build.ok) await options.builder.discard(attempt);

      return { kind: 'cancelled', attempt };
    }

    if (!build.ok)
      return {
        kind: 'failure',
        attempt,
        diagnostics: build.diagnostics,
        inputs: build.inputs,
        durationMs: elapsed(),
      };

    return new Promise<AttemptOutcome>((resolve) => {
      let settled = false;
      let timedOut = false;
      let sawOom = false;
      const child = fork(
        workerPath,
        [
          encodeWorkerArguments({
            bundlePath: build.bundlePath,
            projectRoot: options.projectRoot,
            configPath: options.configPath,
          }),
        ],
        {
          cwd: options.projectRoot,
          env: options.env,
          execArgv: ['--enable-source-maps'],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          serialization: 'json',
        },
      );
      const stdout = new LinePrefixer({
        prefix: streamPrefix(attempt, 'stdout'),
        write: options.writeStdout,
        ...(options.isStdoutSaturated
          ? { isSaturated: options.isStdoutSaturated }
          : {}),
      });
      const stderr = new LinePrefixer({
        prefix: streamPrefix(attempt, 'stderr'),
        write: options.writeStderr,
        ...(options.isStderrSaturated
          ? { isSaturated: options.isStderrSaturated }
          : {}),
      });
      const finish = (outcome: AttemptOutcome) => {
        if (settled) return;

        settled = true;
        clearTimeout(deadline);
        resolve(outcome);
      };
      const failure = (diagnostics: Diagnostic[]) =>
        finish({
          kind: 'failure',
          attempt,
          diagnostics,
          inputs: build.inputs,
          durationMs: elapsed(),
        });
      // The supervisor owns the timer: a busy loop in the child cannot block it.
      const deadline = setTimeout(() => {
        timedOut = true;
        failure([
          {
            kind: 'worker',
            code: 'worker.timeout',
            severity: 'error',
            message: `Loading and compiling the definitions exceeded ${options.evalTimeoutMs} ms; the child was terminated. Unsettled top-level await or an infinite loop in an imported module can cause this.`,
          },
        ]);
        void terminate(child, killGraceMs);
      }, options.evalTimeoutMs);

      children.add(child);
      handle.child = child;

      if (handle.cancelled) void terminate(child, killGraceMs);

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        if (/JavaScript heap out of memory/.test(chunk.toString('utf8')))
          sawOom = true;

        stderr.push(chunk);
      });
      child.stdout?.on('end', () => stdout.end());
      child.stderr?.on('end', () => stderr.end());
      child.on('message', (raw) => {
        const parsed = workerMessageSchema.safeParse(raw);

        if (!parsed.success) {
          failure([
            {
              kind: 'worker',
              code: 'worker.invalid-message',
              severity: 'error',
              message:
                'The application child sent a message the supervisor could not validate',
            },
          ]);
          void terminate(child, killGraceMs);

          return;
        }

        const message = parsed.data;

        if (message.type === 'model')
          finish({
            kind: 'model',
            attempt,
            manifest: message.manifest,
            definitionRevision: message.definitionRevision,
            sites: message.sites,
            inputs: build.inputs,
            durationMs: elapsed(),
          });
        else failure([...message.diagnostics]);
      });
      child.on('error', (error) => {
        failure([
          {
            kind: 'worker',
            code: 'worker.spawn-failed',
            severity: 'error',
            message: `Could not start the application child: ${error.message}`,
          },
        ]);
      });
      child.on('exit', (code, signal) => {
        children.delete(child);
        void options.builder.discard(attempt);

        // A termination we caused (timeout or cancellation) is not a second failure.
        if (settled || timedOut || cancelled()) {
          finish({ kind: 'cancelled', attempt });

          return;
        }

        failure([
          sawOom
            ? {
                kind: 'worker',
                code: 'worker.oom',
                severity: 'error',
                message:
                  'The application child ran out of memory while loading the definitions',
              }
            : {
                kind: 'worker',
                code: 'worker.crash',
                severity: 'error',
                message: `The application child exited before reporting a model (${
                  signal ? `signal ${signal}` : `code ${code}`
                })`,
              },
        ]);
      });
    });
  };
  const cancel = (handle: Handle) => {
    handle.cancelled = true;

    if (handle.child) void terminate(handle.child, killGraceMs);
  };

  return {
    get currentAttempt() {
      return counter;
    },
    start() {
      if (active) cancel(active);

      counter += 1;
      const handle: Handle = {
        attempt: counter,
        child: null,
        cancelled: false,
      };

      active = handle;

      return run(handle).then((outcome) => {
        if (active === handle) active = null;

        return handle.cancelled
          ? { kind: 'cancelled', attempt: handle.attempt }
          : outcome;
      });
    },
    async stop(stopOptions) {
      if (active) cancel(active);

      active = null;
      await Promise.all(
        [...children].map((child) =>
          stopOptions?.immediate
            ? new Promise<void>((resolve) => {
                child.once('exit', () => resolve());
                child.kill('SIGKILL');
              })
            : terminate(child, 5_000),
        ),
      );
    },
  };
}
