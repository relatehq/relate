/**
 * `relate dev`: resolve the project, take its lock, bind the loopback
 * listener, print the URL, then load definitions in replaceable children and
 * publish accepted models to the terminal and the inspector.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import { instanceIdentitySchema } from '@relate/inspector/protocol';
import { createInspectorApp } from '@relate/inspector/server';
import type { InspectorApp } from '@relate/inspector/server';
import { UsageError, devUsage, parseDevArguments } from './arguments.js';
import type { DevArguments } from './arguments.js';
import { createAttemptRunner } from './attempts.js';
import type { AttemptOutcome } from './attempts.js';
import { createBuilder } from './build.js';
import { summarizeDiff } from './diff.js';
import { bindLoopback, ListenError } from './listener.js';
import { acquireLock, devDirectory } from './lock.js';
import type { Lock, LockMetadata } from './lock.js';
import { openBrowser } from './open.js';
import { ProjectError, resolveProject } from './project.js';
import { createDevServer } from './server.js';
import { createSessions } from './session.js';
import { Supervisor } from './supervisor.js';
import { createTerminal, shouldColor } from './terminal.js';
import { createWatcher } from './watcher.js';

export interface RunDevOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: Writable & { isTTY?: boolean; writableLength?: number };
  readonly stderr: Writable & { isTTY?: boolean; writableLength?: number };
  /** Resolves to request a graceful shutdown; a second signal forces it. */
  readonly signals?: AsyncIterable<string> | undefined;
  readonly inspector?: InspectorApp;
  readonly workerPath?: string;
}

export const exitCodes = Object.freeze({ ok: 0, fatal: 1, usage: 2 });

const tokenFile = (projectRoot: string) =>
  join(devDirectory(projectRoot), 'token');

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

export async function runDev(options: RunDevOptions): Promise<number> {
  const write = (stream: Writable, text: string) => {
    stream.write(text);
  };
  let args: DevArguments | 'help';

  try {
    args = parseDevArguments(options.argv);
  } catch (error) {
    if (error instanceof UsageError) {
      write(options.stderr, `${error.message}\n\n${devUsage}`);

      return exitCodes.usage;
    }

    throw error;
  }

  if (args === 'help') {
    write(options.stdout, devUsage);

    return exitCodes.ok;
  }

  const color = shouldColor(options.stderr, options.env);
  const fail = (message: string) => {
    write(
      options.stderr,
      `  ${color ? '\u001b[31merror\u001b[39m' : 'error'}  ${message}\n`,
    );

    return exitCodes.fatal;
  };
  let project;

  try {
    project = await resolveProject(options.cwd, args.config);
  } catch (error) {
    if (error instanceof ProjectError) return fail(error.message);

    throw error;
  }

  const terminal = createTerminal({
    stdout: options.stdout,
    stderr: options.stderr,
    cwd: options.cwd,
    projectRoot: project.root,
    color,
  });
  const instanceId = randomUUID();
  const acquired = await acquireLock({
    projectRoot: project.root,
    configPath: project.configPath,
    instanceId,
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

    write(
      options.stdout,
      [
        `Relate dev is already running for ${project.root}`,
        `Inspector  ${metadata.url}`,
        `Config     ${metadata.configPath}`,
        `PID        ${metadata.pid}`,
        'Use the existing server; stop it with Ctrl+C in its owning terminal to restart.',
        '',
      ].join('\n'),
    );

    if (args.open && metadata.url) {
      // Token material lives in owner-only local storage, read only after verification.
      let token: string | null = null;

      try {
        token =
          (await readFile(tokenFile(project.root), 'utf8')).trim() || null;
      } catch {
        token = null;
      }

      try {
        await openBrowser(
          token ? `${metadata.url}/#token=${token}` : `${metadata.url}/`,
        );
      } catch (error) {
        terminal.warn(`Could not open a browser: ${(error as Error).message}`);
      }
    }

    return exitCodes.ok;
  }

  if (acquired.kind === 'unverifiable')
    return fail(
      `${acquired.reason}.\n         Lock: ${acquired.path}\n         If no relate dev is running for this project, remove that file and retry.`,
    );

  const lock: Lock = acquired.lock;
  let app: Hono | null = null;
  const release = async () => {
    await rm(tokenFile(project.root), { force: true });
    await lock.release();
  };

  try {
    const bound = await bindLoopback(
      () =>
        createAdaptorServer({
          fetch: (request) =>
            app
              ? app.fetch(request)
              : new Response('Starting', { status: 503 }),
        }) as Server,
      args.port,
    );
    const sessions = createSessions({
      instanceId,
      allowedOrigins: [bound.url, ...args.allowedOrigins],
    });
    const supervisor = new Supervisor(instanceId);
    const inspector = options.inspector ?? createInspectorApp();

    try {
      await inspector.verify();
    } catch (error) {
      bound.server.close();
      await release();

      return fail((error as Error).message);
    }

    const server = createDevServer({
      supervisor,
      sessions,
      ownerId: lock.metadata.ownerId,
      inspector,
    });

    app = server.app;
    await writeFile(tokenFile(project.root), sessions.token, { mode: 0o600 });
    await lock.update({ state: 'listening', url: bound.url });
    const inspectorUrl = `${bound.url}/#token=${sessions.token}`;

    // The URL is usable before any definition loads, so a first failure still has an inspector.
    terminal.banner({
      project: project.root,
      config: project.configPath,
      inspectorUrl,
    });

    if (bound.notice) terminal.notice(bound.notice);

    if (args.open)
      try {
        await openBrowser(inspectorUrl);
      } catch (error) {
        terminal.warn(`Could not open a browser: ${(error as Error).message}`);
      }

    const builder = await createBuilder({
      projectRoot: project.root,
      configPath: project.configPath,
    });
    const runner = createAttemptRunner({
      builder,
      projectRoot: project.root,
      configPath: project.configPath,
      evalTimeoutMs: args.evalTimeoutMs,
      env: options.env,
      writeStdout: (line) => terminal.childStdout(line),
      writeStderr: (line) => terminal.childStderr(line),
      isStdoutSaturated: () => (options.stdout.writableLength ?? 0) > 1_000_000,
      isStderrSaturated: () => (options.stderr.writableLength ?? 0) > 1_000_000,
      ...(options.workerPath ? { workerPath: options.workerPath } : {}),
    });
    let lastGoodInputs: readonly string[] = [project.configPath];
    let stopping = false;
    const watcher = createWatcher({
      projectRoot: project.root,
      onChange: (files) => {
        if (!stopping) void attempt(files);
      },
      onError: (error) => terminal.warn(`Watcher error: ${error.message}`),
    });
    const handle = (changed: readonly string[], outcome: AttemptOutcome) => {
      if (stopping || outcome.kind === 'cancelled') return;

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

        if (event.fromGeneration === null)
          terminal.ready(
            event.model.generation,
            event.model.manifest,
            outcome.durationMs,
          );
        else
          terminal.update(
            files,
            event.model.generation,
            summarizeDiff(previous, event.model.manifest, event.diff),
            outcome.durationMs,
          );

        return;
      }

      // A failed build keeps the last good watch set so a fix can recover.
      watcher.update([...new Set([...lastGoodInputs, ...outcome.inputs])]);
      supervisor.acceptFailure(outcome.attempt, outcome.diagnostics);
      terminal.error(
        files,
        outcome.attempt,
        outcome.diagnostics,
        supervisor.state.model?.generation ?? null,
      );
    };
    const attempt = async (files: readonly string[]) => {
      try {
        handle(files, await runner.start());
      } catch (error) {
        terminal.warn(
          `Attempt failed unexpectedly: ${(error as Error).message}`,
        );
      }
    };

    watcher.update(lastGoodInputs);
    terminal.loading(1);
    void attempt([]);

    const exitCode = await new Promise<number>((resolve) => {
      let forced = false;
      const onSignal = () => void shutdown();
      const shutdown = async () => {
        if (stopping) {
          if (!forced) {
            forced = true;
            await runner.stop({ immediate: true });
          }

          return;
        }

        stopping = true;
        watcher.close();
        server.closeStreams();
        sessions.clear();
        await runner.stop();
        await builder.dispose();
        await new Promise<void>((done) => bound.server.close(() => done()));
        await release();
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        resolve(exitCodes.ok);
      };

      if (options.signals)
        void (async () => {
          for await (const _signal of options.signals!) void shutdown();
        })();
      else {
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
      }
    });

    return exitCode;
  } catch (error) {
    await release();

    if (error instanceof ListenError) return fail(error.message);

    throw error;
  }
}
