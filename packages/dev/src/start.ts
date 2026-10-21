/**
 * `relate dev`: resolve the project, take its lock, bind the loopback
 * listener, then load definitions in replaceable children and publish accepted
 * models to the inspector and the caller. No terminal or process signal ownership.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { instanceIdentitySchema } from '@relate/inspector/protocol';
import { createInspectorApp } from '@relate/inspector/server';
import type { InspectorApp } from '@relate/inspector/server';
import { createActivityLog } from './activity/index.js';
import { agentSetup, connectLoopbackMcp, createAgent } from './agent.js';
import { createAttemptRunner } from './attempts.js';
import type { AttemptOutcome } from './attempts.js';
import { createBuilder } from './build.js';
import { createRuntimeController } from './runtime-controller.js';
import { summarizeDiff } from './diff.js';
import { bindLoopback } from './listener.js';
import { createMcpEndpoint, mcpAddCommand, readMcpToken } from './mcp.js';
import { createPlayground } from './playground.js';
import { acquireLock, devDirectory } from './lock.js';
import type { Lock, LockMetadata } from './lock.js';
import { resolveProject } from './project.js';
import type { Project } from './project.js';
import { createDevServer } from './server.js';
import { createSessions } from './session.js';
import { Supervisor } from './supervisor.js';
import { createWatcher } from './watcher.js';

import type { Manifest } from 'relate/model';
import type { Diagnostic, RuntimeStatus } from '@relate/inspector/protocol';
import { normalizeDevOptions } from './options.js';

/** Notifications from the service; the caller chooses how to present them. */
export type DevServiceEvent =
  | { readonly type: 'project'; readonly project: Project }
  | { readonly type: 'listening'; readonly info: DevServiceInfo }
  | { readonly type: 'notice' | 'warning'; readonly message: string }
  | { readonly type: 'loading'; readonly attempt: number }
  | {
      readonly type: 'ready';
      readonly generation: number;
      readonly manifest: Manifest;
      readonly durationMs: number;
    }
  | {
      readonly type: 'update';
      readonly files: readonly string[];
      readonly generation: number;
      readonly summary: string;
      readonly durationMs: number;
    }
  | {
      readonly type: 'diagnostics';
      readonly files: readonly string[];
      readonly attempt: number;
      readonly diagnostics: readonly Diagnostic[];
      readonly keptGeneration: number | null;
    }
  | { readonly type: 'runtime'; readonly status: RuntimeStatus }
  | {
      readonly type: 'output';
      readonly stream: 'stdout' | 'stderr';
      readonly line: string;
    };

export interface StartDevOptions {
  readonly cwd: string;
  readonly config?: string | undefined;
  readonly port?: number | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtime?: boolean;
  readonly seed?: boolean;
  readonly rotateMcpToken?: boolean;
  readonly evalTimeoutMs?: number;
  readonly allowedOrigins?: readonly string[];
  readonly onEvent?: (event: DevServiceEvent) => void;
  /** Drop child output while a caller's output sink is saturated. */
  readonly isOutputSaturated?: (stream: 'stdout' | 'stderr') => boolean;
  readonly inspector?: InspectorApp;
  readonly workerPath?: string;
  readonly runtimeHostPath?: string;
}

export interface DevServiceInfo {
  readonly project: Project;
  readonly inspectorUrl: string;
  readonly mcpUrl: string;
  readonly mcpCommand?: string;
  readonly pid: number;
}

export interface DevService extends DevServiceInfo {
  /** An existing owner is reused; close() never stops another owner's service. */
  readonly kind: 'started' | 'existing';
  /** Idempotent cleanup. Immediate stops a pending compile child without grace. */
  close(options?: { readonly immediate?: boolean }): Promise<void>;
}

export class DevStartError extends Error {
  constructor(
    message: string,
    readonly lock?: { readonly reason: string; readonly path: string },
  ) {
    super(message);
    this.name = 'DevStartError';
  }
}

const tokenFile = (projectRoot: string) =>
  join(devDirectory(projectRoot), 'token');
const mcpTokenFile = (projectRoot: string) =>
  join(devDirectory(projectRoot), 'mcp-token');

async function readSecret(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function verifyOwner(metadata: LockMetadata): Promise<boolean> {
  if (!metadata.url) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch(`${metadata.url}/dev/instance`, {
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return false;

    const identity = instanceIdentitySchema.safeParse(await response.json());

    return identity.success && identity.data.ownerId === metadata.ownerId;
  } catch {
    return false;
  }
}

/** Start once; accepted application builds replace children, never this service. */
export async function startDev(options: StartDevOptions): Promise<DevService> {
  const args = {
    ...options,
    ...normalizeDevOptions(options),
  };
  const env = options.env ?? process.env;
  const emit = (event: DevServiceEvent) => options.onEvent?.(event);
  const project = await resolveProject(options.cwd, args.config);

  emit({ type: 'project', project });
  const fail = (message: string): never => {
    throw new DevStartError(message);
  };
  const instanceId = randomUUID();
  const acquired = await acquireLock({
    projectRoot: project.root,
    configPath: project.configPath,
    instanceId,
    seed: args.seed,
    verifyOwner,
  });

  if (acquired.kind === 'held') {
    const { metadata } = acquired;

    if (metadata.configPath !== project.configPath)
      return fail(
        `Relate dev is already running for ${project.root} with a different config (${metadata.configPath}, PID ${metadata.pid}). Stop it first or run this command from the same configuration.`,
      );

    if (
      args.port !== undefined &&
      metadata.url &&
      new URL(metadata.url).port !== String(args.port)
    )
      return fail(
        `Relate dev is already running for ${project.root} on ${metadata.url} (PID ${metadata.pid}); it cannot be moved to port ${args.port}. Stop it first.`,
      );

    if (args.seed !== (metadata.seed ?? false))
      return fail(
        `Relate dev is already running for ${project.root} (PID ${metadata.pid}) with ${metadata.seed === undefined ? 'an unknown --seed setting' : metadata.seed ? '--seed enabled' : '--seed disabled'}. This invocation requests --seed ${args.seed ? 'enabled' : 'disabled'}. Stop the existing server first and restart with the requested flags.`,
      );

    // Reuse the complete bootstrap link, just as the initial banner does.
    // Read owner-only token material only after verifying the running owner.
    const token = await readSecret(tokenFile(project.root));
    const mcpToken = await readSecret(mcpTokenFile(project.root));
    const inspectorUrl = token
      ? `${metadata.url}/#token=${token}`
      : `${metadata.url}/`;

    return {
      kind: 'existing',
      project,
      inspectorUrl,
      mcpUrl: `${metadata.url}/mcp`,
      ...(mcpToken
        ? { mcpCommand: mcpAddCommand(`${metadata.url}/mcp`, mcpToken) }
        : {}),
      pid: metadata.pid,
      async close() {},
    };
  }

  if (acquired.kind === 'unverifiable')
    throw new DevStartError(acquired.reason, {
      reason: acquired.reason,
      path: acquired.path,
    });

  const lock: Lock = acquired.lock;
  let app: Hono | null = null;
  const release = async () => {
    await rm(tokenFile(project.root), { force: true });
    await lock.release();
  };

  let stopping = false;
  let closing: Promise<void> | undefined;
  const resources: Partial<{
    bound: Awaited<ReturnType<typeof bindLoopback>>;
    sessions: ReturnType<typeof createSessions>;
    agent: ReturnType<typeof createAgent>;
    runtime: ReturnType<typeof createRuntimeController>;
    server: ReturnType<typeof createDevServer>;
    builder: Awaited<ReturnType<typeof createBuilder>>;
    runner: ReturnType<typeof createAttemptRunner>;
    watcher: ReturnType<typeof createWatcher>;
  }> = {};
  const close = (closeOptions?: {
    readonly immediate?: boolean;
  }): Promise<void> => {
    stopping = true;
    const immediate = closeOptions?.immediate
      ? resources.runner?.stop({ immediate: true })
      : undefined;

    closing ??= (async () => {
      const errors: unknown[] = [];

      // Keep MCP reachable until agent turns stop. Always release the lock,
      // including when startup failed after opening some resources.
      for (const dispose of [
        () => resources.watcher?.close(),
        () => resources.agent?.stop(),
        () => resources.server?.closeStreams(),
        () => resources.sessions?.clear(),
        () => resources.runner?.stop(),
        () => resources.runtime?.stop(),
        () => resources.builder?.dispose(),
        () =>
          resources.bound &&
          new Promise<void>((done) =>
            resources.bound!.server.close(() => done()),
          ),
        release,
      ]) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }

      if (errors.length)
        throw new AggregateError(
          errors,
          'Could not fully close the development service',
        );
    })();

    return immediate
      ? Promise.all([closing, immediate]).then(() => {})
      : closing;
  };

  try {
    const bound = (resources.bound = await bindLoopback(
      () =>
        createAdaptorServer({
          fetch: (request) =>
            app
              ? app.fetch(request)
              : new Response('Starting', { status: 503 }),
        }) as Server,
      args.port,
    ));
    const sessions = (resources.sessions = createSessions({
      instanceId,
      allowedOrigins: [bound.url, ...args.allowedOrigins],
    }));
    const supervisor = new Supervisor(instanceId);
    const inspector = options.inspector ?? createInspectorApp();

    try {
      await inspector.verify();
    } catch (error) {
      throw new DevStartError((error as Error).message);
    }

    const isStdoutSaturated = () =>
      options.isOutputSaturated?.('stdout') ?? false;
    const isStderrSaturated = () =>
      options.isOutputSaturated?.('stderr') ?? false;
    // Created before `/mcp` can answer, so a request during startup sees the
    // runtime starting rather than a runtime that is off.
    // `--no-runtime`: inspect the model only; accepted bundles are released.
    const activity = createActivityLog();
    const runtime = args.runtime
      ? (resources.runtime = createRuntimeController({
          activity,
          seed: args.seed,
          projectRoot: project.root,
          configPath: project.configPath,
          env,
          onStatus: (status) => {
            if (stopping) return;

            supervisor.acceptRuntime(status);
            emit({ type: 'runtime', status });
          },
          writeStdout: (line) =>
            emit({ type: 'output', stream: 'stdout', line }),
          writeStderr: (line) =>
            emit({ type: 'output', stream: 'stderr', line }),
          isStdoutSaturated,
          isStderrSaturated,
          ...(options.runtimeHostPath
            ? { hostPath: options.runtimeHostPath }
            : {}),
        }))
      : null;
    const { token: mcpToken } = await readMcpToken(devDirectory(project.root), {
      rotate: args.rotateMcpToken,
    });
    const mcp = createMcpEndpoint({
      token: mcpToken,
      runtime,
      principals: () => {
        const model = supervisor.state.model;

        return model
          ? {
              names: model.principals,
              defaultPrincipal: model.defaultPrincipal,
            }
          : null;
      },
      activity,
    });
    // The agent reads ANTHROPIC_API_KEY here, in the dev server, and reaches
    // the graph through its own /mcp with the in-process agent token.
    const agent = (resources.agent = createAgent({
      env,
      principals: () => {
        const model = supervisor.state.model;

        return model ? { names: model.principals } : null;
      },
      connect: connectLoopbackMcp({
        url: `${bound.url}/mcp`,
        token: mcp.agentToken,
      }),
      runtimeId: () =>
        runtime?.status?.state === 'running' ? runtime.status.runtimeId : null,
    }));
    const playground = createPlayground({
      runtime,
      principals: () => {
        const model = supervisor.state.model;

        return model ? { names: model.principals } : null;
      },
      activity,
    });
    const server = (resources.server = createDevServer({
      supervisor,
      sessions,
      ownerId: lock.metadata.ownerId,
      inspector,
      activity,
      agent,
      playground,
      mcp: mcp.handle,
    }));

    app = server.app;
    await writeFile(tokenFile(project.root), sessions.token, { mode: 0o600 });
    await lock.update({ state: 'listening', url: bound.url });
    const inspectorUrl = `${bound.url}/#token=${sessions.token}`;

    // The URL is usable before any definition loads, so a first failure still has an inspector.
    const info: DevServiceInfo = {
      project,
      inspectorUrl,
      mcpUrl: `${bound.url}/mcp`,
      mcpCommand: mcpAddCommand(`${bound.url}/mcp`, mcp.token),
      pid: process.pid,
    };

    emit({ type: 'listening', info });

    if (bound.notice) emit({ type: 'notice', message: bound.notice });

    if (!args.runtime)
      emit({
        type: 'notice',
        message:
          'Runtime    off (--no-runtime); the application is not started',
      });

    if (!agent.availability.available)
      emit({
        type: 'notice',
        message: `Agent      off: no ANTHROPIC_API_KEY. ${agentSetup}`,
      });

    const builder = (resources.builder = await createBuilder({
      projectRoot: project.root,
      configPath: project.configPath,
    }));
    const runner = (resources.runner = createAttemptRunner({
      builder,
      projectRoot: project.root,
      configPath: project.configPath,
      evalTimeoutMs: args.evalTimeoutMs,
      env,
      writeStdout: (line) => emit({ type: 'output', stream: 'stdout', line }),
      writeStderr: (line) => emit({ type: 'output', stream: 'stderr', line }),
      isStdoutSaturated,
      isStderrSaturated,
      ...(options.workerPath ? { workerPath: options.workerPath } : {}),
    }));

    let lastGoodInputs: readonly string[] = [project.configPath];
    const watcher = (resources.watcher = createWatcher({
      projectRoot: project.root,
      onChange: (files) => {
        if (!stopping) void attempt(files);
      },
      onError: (error) =>
        emit({ type: 'warning', message: `Watcher error: ${error.message}` }),
    }));
    const handle = (changed: readonly string[], outcome: AttemptOutcome) => {
      if (outcome.kind === 'cancelled') return;

      if (stopping) {
        if (outcome.kind === 'model') void outcome.bundle.release();

        return;
      }

      // Prefer known modules over editor temporaries that landed in the same directory.
      const known = changed.filter((file) => lastGoodInputs.includes(file));
      const files = known.length ? known : changed;

      if (outcome.kind === 'model') {
        lastGoodInputs = outcome.inputs;
        watcher.update(outcome.inputs);
        const { event, previous } = supervisor.acceptModel(
          outcome,
          outcome.durationMs,
        );

        // Every accepted build restarts the runtime: connector and action
        // code may have changed even when the Manifest did not. `restart`
        // reports its own failures as runtime status and never rejects.
        if (runtime)
          void runtime.restart({
            generation: event.model.generation,
            bundle: outcome.bundle,
          });
        else void outcome.bundle.release();

        if (event.fromGeneration === null)
          emit({
            type: 'ready',
            generation: event.model.generation,
            manifest: event.model.manifest,
            durationMs: outcome.durationMs,
          });
        else
          emit({
            type: 'update',
            files,
            generation: event.model.generation,
            summary: summarizeDiff(previous, event.model.manifest, event.diff),
            durationMs: outcome.durationMs,
          });

        return;
      }

      // A failed build keeps the last good watch set so a fix can recover.
      watcher.update([...new Set([...lastGoodInputs, ...outcome.inputs])]);
      supervisor.acceptFailure(outcome.attempt, outcome.diagnostics);
      emit({
        type: 'diagnostics',
        files,
        attempt: outcome.attempt,
        diagnostics: outcome.diagnostics,
        keptGeneration: supervisor.state.model?.generation ?? null,
      });
    };
    const attempt = async (files: readonly string[]) => {
      try {
        handle(files, await runner.start());
      } catch (error) {
        emit({
          type: 'warning',
          message: `Attempt failed unexpectedly: ${(error as Error).message}`,
        });
      }
    };

    watcher.update(lastGoodInputs);
    emit({ type: 'loading', attempt: 1 });
    void attempt([]);

    return { ...info, kind: 'started', close };
  } catch (error) {
    // Cleanup attempts every disposer; its failure must not replace the startup error.
    await close().catch(() => {});
    throw error;
  }
}
