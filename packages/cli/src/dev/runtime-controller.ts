/**
 * Parent side of the runtime host: one host per accepted build. Every
 * accepted build restarts it, even when the Manifest is unchanged, because
 * connector and action code may have changed. A restart retires the current
 * `runtimeId` (new requests fail with `runtime-retired`), asks the host to
 * drain and close within a deadline, kills it if it does not, then starts the
 * replacement with a fresh `runtimeId`.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConsumerDescription } from 'relate/consumer';
import { ActionError, ReadError } from '@relate/protocol';
import type { Diagnostic, RuntimeStatus } from '@relate/inspector/protocol';
import { spawnChild, type ManagedChild } from './child-process.js';
import {
  createRuntimeBinding,
  type RuntimeBinding,
  type RuntimeConnection,
} from './runtime-binding.js';
import {
  encodeRuntimeHostArguments,
  restoreError,
  retiredError,
  userCodeEnvironment,
  runtimeMessageSchema,
  type RuntimeOperation,
  type RuntimeRequest,
} from './runtime-protocol.js';

export interface AcceptedBuild {
  /** The accepted model generation this runtime serves. */
  readonly generation: number;
  readonly bundle: { readonly path: string; release(): Promise<void> };
}

export interface RuntimeControllerOptions {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onStatus: (status: RuntimeStatus) => void;
  readonly writeStdout: (line: string) => void;
  readonly writeStderr: (line: string) => void;
  readonly isStdoutSaturated?: () => boolean;
  readonly isStderrSaturated?: () => boolean;
  readonly hostPath?: string;
  /** Deadline for `setup` and the store check. */
  readonly startTimeoutMs?: number;
  /** How long a retired runtime may drain before it is killed. */
  readonly drainTimeoutMs?: number;
}

export interface RuntimeController {
  /**
   * Retire the current runtime and start one for this build. Never rejects:
   * a host that cannot start is reported as a `failed` status.
   */
  restart(build: AcceptedBuild): Promise<void>;
  /** The active runtime's binding for a declared principal; cached until it retires. */
  binding(principal: string): Promise<RuntimeBinding>;
  readonly status: RuntimeStatus | null;
  /** Retire the active runtime and wait for every host to exit. */
  stop(): Promise<void>;
}

/**
 * Why `binding()` cannot serve a principal right now. Transport-independent;
 * `/mcp` forwards the message to the caller.
 */
export class RuntimeUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-running' | 'unknown-principal',
    /** True when a later runtime (the next restart) can serve the request. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RuntimeUnavailableError';
  }
}

function notRunning(status: RuntimeStatus | null): RuntimeUnavailableError {
  switch (status?.state) {
    case 'starting':
    case 'restarting':
      return new RuntimeUnavailableError(
        'The runtime is restarting; retry shortly',
        'not-running',
        true,
      );
    case 'failed':
      return new RuntimeUnavailableError(
        'The runtime failed to start; fix the runtime diagnostics shown by relate dev, then save',
        'not-running',
        false,
      );
    case 'not-configured':
      return new RuntimeUnavailableError(
        'The runtime is not configured; export defineApp({ graph, setup }) to run it',
        'not-running',
        false,
      );
    default:
      return new RuntimeUnavailableError(
        'The runtime has not started yet; retry shortly',
        'not-running',
        true,
      );
  }
}

export const DEFAULT_RUNTIME_START_TIMEOUT_MS = 30_000;
export const DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS = 5_000;

export function defaultRuntimeHostPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'runtime-host.js');
}

interface Pending {
  readonly operation: RuntimeOperation | 'discovery';
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface Host {
  readonly runtimeId: string;
  readonly generation: number;
  readonly child: ManagedChild;
  readonly pending: Map<number, Pending>;
  readonly bindings: Map<string, Promise<RuntimeBinding>>;
  state: 'starting' | 'running' | 'not-configured' | 'failed' | 'retired';
  ready?: {
    readonly definitionRevision: string;
    readonly store: 'memory' | 'application';
    readonly principals: readonly string[];
    readonly consumer: ConsumerDescription;
  };
}

/** A request cut off by the host's exit: an action's outcome is unknown. */
function lostError(operation: RuntimeOperation | 'discovery'): Error {
  if (operation === 'invoke') return new ActionError('uncertain');

  if (operation === 'getReceipt') return new ActionError('unavailable');

  return new ReadError('unavailable');
}

/** Arguments IPC cannot carry (functions, symbols) never reach the runtime. */
function unsendableError(operation: RuntimeOperation | 'discovery'): Error {
  return operation === 'invoke' || operation === 'getReceipt'
    ? new ActionError('invalid')
    : new ReadError('invalid-request');
}

export function createRuntimeController(
  options: RuntimeControllerOptions,
): RuntimeController {
  const hostPath = options.hostPath ?? defaultRuntimeHostPath();
  const startTimeoutMs =
    options.startTimeoutMs ?? DEFAULT_RUNTIME_START_TIMEOUT_MS;
  const drainTimeoutMs =
    options.drainTimeoutMs ?? DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS;
  const hosts = new Set<Host>();
  let active: Host | null = null;
  let status: RuntimeStatus | null = null;
  let requestId = 0;
  let latest = 0;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const publish = (next: RuntimeStatus) => {
    status = next;
    options.onStatus(next);
  };
  const connection = (host: Host): RuntimeConnection => ({
    runtimeId: host.runtimeId,
    request(request) {
      const operation = request.type === 'op' ? request.operation : 'discovery';

      // Pinned: a retired runtime never answers, and nothing is redirected.
      if (host.state === 'retired' || host !== active)
        return Promise.reject(retiredError(operation));

      if (host.state !== 'running' || !host.child.process.connected)
        return Promise.reject(lostError(operation));

      const id = ++requestId;
      const message: RuntimeRequest =
        request.type === 'op'
          ? {
              type: 'op',
              id,
              runtimeId: host.runtimeId,
              principal: request.principal,
              operation: request.operation,
              args: [...request.args],
            }
          : {
              type: 'discovery',
              id,
              runtimeId: host.runtimeId,
              principal: request.principal,
            };

      return new Promise((resolve, reject) => {
        host.pending.set(id, { operation, resolve, reject });

        try {
          host.child.process.send(message, (error) => {
            if (!error) return;

            host.pending.delete(id);
            reject(lostError(operation));
          });
        } catch {
          // Structured clone refused a value before anything was sent.
          host.pending.delete(id);
          reject(unsendableError(operation));
        }
      });
    },
  });
  const retire = async (host: Host) => {
    if (host.state === 'retired') {
      await host.child.exited;

      return;
    }

    host.state = 'retired';
    host.bindings.clear();
    // Ask the host to drain and close; kill it at the deadline.
    await host.child.terminate(drainTimeoutMs, () => {
      if (host.child.process.connected)
        host.child.process.send(
          { type: 'close' } satisfies RuntimeRequest,
          () => {},
        );
      else host.child.process.kill('SIGTERM');
    });
  };
  const start = (
    build: AcceptedBuild,
    previous: Host | null,
    runtimeId: string,
  ) => {
    const previousStore =
      previous?.state === 'retired' && previous.ready
        ? previous.ready.store
        : null;
    const prefix = (stream: 'stdout' | 'stderr') =>
      `[runtime gen ${build.generation} ${stream}]`;
    // Structured clone, not JSON: action inputs reach validation unchanged
    // (NaN stays NaN instead of becoming null), as in an embedded runtime.
    const child = spawnChild({
      modulePath: hostPath,
      argument: encodeRuntimeHostArguments({
        bundlePath: build.bundle.path,
        projectRoot: options.projectRoot,
        configPath: options.configPath,
        runtimeId,
        drainTimeoutMs,
      }),
      cwd: options.projectRoot,
      env: userCodeEnvironment(options.env),
      serialization: 'advanced',
      stdout: {
        prefix: prefix('stdout'),
        write: options.writeStdout,
        ...(options.isStdoutSaturated
          ? { isSaturated: options.isStdoutSaturated }
          : {}),
      },
      stderr: {
        prefix: prefix('stderr'),
        write: options.writeStderr,
        ...(options.isStderrSaturated
          ? { isSaturated: options.isStderrSaturated }
          : {}),
      },
    });
    const host: Host = {
      runtimeId,
      generation: build.generation,
      child,
      pending: new Map(),
      bindings: new Map(),
      state: 'starting',
    };
    const base = {
      runtimeId,
      generation: build.generation,
      dataReset: false,
      diagnostics: [] as Diagnostic[],
    };
    const failed = (diagnostics: Diagnostic[]) => {
      if (host.state !== 'starting' && host.state !== 'running') return;

      host.state = 'failed';

      if (active === host)
        publish({
          ...base,
          state: 'failed',
          definitionRevision: null,
          store: host.ready?.store ?? null,
          diagnostics,
        });

      void child.kill();
    };
    const startup = setTimeout(() => {
      failed([
        {
          kind: 'runtime',
          code: 'runtime.timeout',
          severity: 'error',
          message: `Starting the runtime exceeded ${startTimeoutMs} ms; the runtime host was terminated. A setup function that never settles can cause this.`,
        },
      ]);
    }, startTimeoutMs);

    hosts.add(host);
    child.process.on('message', (raw) => {
      const parsed = runtimeMessageSchema.safeParse(raw);

      if (!parsed.success) {
        failed([
          {
            kind: 'runtime',
            code: 'runtime.invalid-message',
            severity: 'error',
            message:
              'The runtime host sent a message the dev server could not validate',
          },
        ]);

        return;
      }

      const message = parsed.data;

      switch (message.type) {
        case 'reply':
        case 'error': {
          const pending = host.pending.get(message.id);

          if (!pending) return;

          host.pending.delete(message.id);

          if (message.type === 'reply') pending.resolve(message.value);
          else pending.reject(restoreError(message.error));

          return;
        }
        case 'ready': {
          clearTimeout(startup);

          if (message.runtimeId !== runtimeId || host.state !== 'starting')
            return;

          host.state = 'running';
          host.ready = {
            definitionRevision: message.definitionRevision,
            store: message.store,
            principals: message.principals,
            consumer: message.consumer as unknown as ConsumerDescription,
          };

          if (active === host)
            publish({
              ...base,
              state: 'running',
              definitionRevision: message.definitionRevision,
              store: message.store,
              dataReset: previousStore === 'memory',
            });

          return;
        }
        case 'failed':
          clearTimeout(startup);

          if (message.runtimeId === runtimeId) failed([...message.diagnostics]);

          return;
        case 'not-configured':
          clearTimeout(startup);

          if (message.runtimeId !== runtimeId || host.state !== 'starting')
            return;

          // Nothing to run is not a failure; the host exits on its own.
          host.state = 'not-configured';

          if (active === host)
            publish({
              ...base,
              state: 'not-configured',
              definitionRevision: null,
              store: null,
              diagnostics: [...message.diagnostics],
            });

          return;
      }
    });
    // Also settles when the spawn fails and Node emits no `exit`.
    void child.exited.then(({ code, signal, spawnError }) => {
      clearTimeout(startup);
      hosts.delete(host);
      void build.bundle.release();

      for (const [id, pending] of host.pending) {
        host.pending.delete(id);
        pending.reject(
          host.state === 'retired' && pending.operation !== 'invoke'
            ? retiredError(pending.operation)
            : lostError(pending.operation),
        );
      }

      if (spawnError) {
        failed([
          {
            kind: 'runtime',
            code: 'runtime.spawn-failed',
            severity: 'error',
            message: `Could not start the runtime host: ${spawnError.message}`,
          },
        ]);

        return;
      }

      failed([
        {
          kind: 'runtime',
          code: host.state === 'running' ? 'runtime.exited' : 'runtime.crash',
          severity: 'error',
          message: `The runtime host exited ${
            host.state === 'running' ? 'while running' : 'before it was ready'
          } (${signal ? `signal ${signal}` : `code ${code}`})`,
        },
      ]);
    });

    active = host;
  };
  /** A host that could not even be forked: report it, release its bundle. */
  const unstartable = (
    build: AcceptedBuild,
    runtimeId: string,
    error: unknown,
  ) => {
    active = null;
    void build.bundle.release();
    publish({
      state: 'failed',
      runtimeId,
      generation: build.generation,
      definitionRevision: null,
      store: null,
      dataReset: false,
      diagnostics: [
        {
          kind: 'runtime',
          code: 'runtime.spawn-failed',
          severity: 'error',
          message: `Could not start the runtime host: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    });
  };

  return {
    get status() {
      return status;
    },
    restart(build) {
      const ticket = ++latest;

      // Restarts are serialized; a superseded build never starts.
      queue = queue
        .catch(() => {})
        .then(async () => {
          // A newer build is queued; it retires the current runtime itself.
          if (stopped || ticket !== latest) {
            await build.bundle.release();

            return;
          }

          const previous = active;
          const runtimeId = randomUUID();

          // Say so before draining: the retired runtime no longer answers.
          publish({
            state: previous?.state === 'running' ? 'restarting' : 'starting',
            runtimeId,
            generation: build.generation,
            definitionRevision: null,
            store: null,
            dataReset: false,
            diagnostics: [],
          });

          if (previous) await retire(previous);

          if (stopped || ticket !== latest) {
            await build.bundle.release();

            return;
          }

          try {
            start(build, previous, runtimeId);
          } catch (error) {
            unstartable(build, runtimeId, error);
          }
        });

      return queue;
    },
    binding(principal) {
      const host = active;

      if (!host || host.state !== 'running' || !host.ready)
        return Promise.reject(notRunning(status));

      // The model may already declare it; this runtime predates that build.
      if (!host.ready.principals.includes(principal))
        return Promise.reject(
          new RuntimeUnavailableError(
            `The running runtime (gen ${host.generation}) does not declare principal '${principal}'; it serves ${
              host.ready.principals.join(', ') || 'no principals'
            }. It restarts with the next accepted build.`,
            'unknown-principal',
            true,
          ),
        );

      let binding = host.bindings.get(principal);

      if (!binding) {
        binding = createRuntimeBinding({
          connection: connection(host),
          definitionRevision: host.ready.definitionRevision,
          principal,
          description: host.ready.consumer,
        });
        // A failed snapshot is not cached; the next call retries.
        binding.catch(() => host.bindings.delete(principal));
        host.bindings.set(principal, binding);
      }

      return binding;
    },
    async stop() {
      stopped = true;
      latest += 1;
      await queue.catch(() => {});

      if (active) await retire(active);

      active = null;
      await Promise.all([...hosts].map((host) => retire(host)));
    },
  };
}
