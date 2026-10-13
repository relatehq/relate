/**
 * Build attempts: bundle, spawn a fresh application child, enforce the
 * evaluation deadline and classify the outcome. Only the newest attempt may
 * report; superseded ones are cancelled silently.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from 'relate/model';
import type { SourceSite } from 'relate/diagnostics';
import type { Diagnostic } from '@relate/inspector/protocol';
import type { Builder } from './build.js';
import { spawnChild, type ManagedChild } from './child-process.js';
import { userCodeEnvironment } from './runtime-protocol.js';
import { streamPrefix } from './streams.js';
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
      readonly principals: readonly string[];
      readonly sites: Readonly<Record<string, SourceSite>>;
      readonly inputs: readonly string[];
      readonly durationMs: number;
      /**
       * The accepted bundle, kept for the runtime host. The caller owns it and
       * must call `release()` once nothing imports it any more.
       */
      readonly bundle: {
        readonly path: string;
        release(): Promise<void>;
      };
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
  child: ManagedChild | null;
  cancelled: boolean;
}

export function defaultWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'worker.js');
}

export function createAttemptRunner(
  options: AttemptRunnerOptions,
): AttemptRunner {
  const workerPath = options.workerPath ?? defaultWorkerPath();
  const killGraceMs = options.killGraceMs ?? 2_000;
  let counter = 0;
  let active: Handle | null = null;
  const children = new Set<ManagedChild>();
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
      let accepted = false;
      let timedOut = false;
      let sawOom = false;
      const child = spawnChild({
        modulePath: workerPath,
        argument: encodeWorkerArguments({
          bundlePath: build.bundlePath,
          projectRoot: options.projectRoot,
          configPath: options.configPath,
        }),
        cwd: options.projectRoot,
        // The worker imports the same user modules as the runtime host.
        env: userCodeEnvironment(options.env),
        serialization: 'json',
        stdout: {
          prefix: streamPrefix(attempt, 'stdout'),
          write: options.writeStdout,
          ...(options.isStdoutSaturated
            ? { isSaturated: options.isStdoutSaturated }
            : {}),
        },
        stderr: {
          prefix: streamPrefix(attempt, 'stderr'),
          write: options.writeStderr,
          ...(options.isStderrSaturated
            ? { isSaturated: options.isStderrSaturated }
            : {}),
        },
        onStderr: (chunk) => {
          if (/JavaScript heap out of memory/.test(chunk.toString('utf8')))
            sawOom = true;
        },
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
        void child.terminate(killGraceMs);
      }, options.evalTimeoutMs);

      children.add(child);
      handle.child = child;

      if (handle.cancelled) void child.terminate(killGraceMs);

      child.process.on('message', (raw) => {
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
          void child.terminate(killGraceMs);

          return;
        }

        const message = parsed.data;

        if (message.type === 'model') {
          if (settled || cancelled()) return;

          // From here the outcome owns the bundle: the runtime host loads it.
          accepted = true;
          finish({
            kind: 'model',
            attempt,
            manifest: message.manifest,
            definitionRevision: message.definitionRevision,
            principals: message.principals,
            sites: message.sites,
            inputs: build.inputs,
            durationMs: elapsed(),
            bundle: {
              path: build.bundlePath,
              release: () => options.builder.discard(attempt),
            },
          });
        } else failure([...message.diagnostics]);
      });
      void child.exited.then(({ code, signal, spawnError }) => {
        children.delete(child);

        // Until it is accepted, the bundle belongs to this attempt.
        if (!accepted) void options.builder.discard(attempt);

        if (spawnError) {
          failure([
            {
              kind: 'worker',
              code: 'worker.spawn-failed',
              severity: 'error',
              message: `Could not start the application child: ${spawnError.message}`,
            },
          ]);

          return;
        }

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

    if (handle.child) void handle.child.terminate(killGraceMs);
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

        // Cancelled after acceptance: the bundle is the outcome's, and nobody
        // else will receive it.
        if (handle.cancelled && outcome.kind === 'model')
          void outcome.bundle.release();

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
          stopOptions?.immediate ? child.kill() : child.terminate(5_000),
        ),
      );
    },
  };
}
