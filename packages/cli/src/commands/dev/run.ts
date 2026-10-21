/** Command adapter: flags, presentation, browser opening and process signals. */
import type { Writable } from 'node:stream';
import { DevStartError, startDev } from '@relate/dev';
import type { DevService, DevServiceEvent } from '@relate/dev';
import { UsageError, devUsage, parseDevArguments } from './arguments.js';
import { openBrowser } from './open.js';
import { createTerminal, shouldColor } from './terminal.js';
import type { Terminal } from './terminal.js';

export interface RunDevOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: Writable & { isTTY?: boolean; writableLength?: number };
  readonly stderr: Writable & { isTTY?: boolean; writableLength?: number };
}

export const exitCodes = Object.freeze({ ok: 0, fatal: 1, usage: 2 });

export async function runDev(options: RunDevOptions): Promise<number> {
  let args;

  try {
    args = parseDevArguments(options.argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;

    options.stderr.write(`${error.message}\n\n${devUsage}`);

    return exitCodes.usage;
  }

  if (args === 'help') {
    options.stdout.write(devUsage);

    return exitCodes.ok;
  }

  const color = shouldColor(options.stderr, options.env);
  let terminal: Terminal;
  const onEvent = (event: DevServiceEvent) => {
    switch (event.type) {
      case 'project':
        terminal = createTerminal({
          ...options,
          projectRoot: event.project.root,
          color,
          quiet: args.quiet,
        });
        break;
      case 'listening':
        terminal.banner({
          ...event.info,
          project: event.info.project.root,
          config: event.info.project.configPath,
        });
        break;
      case 'notice':
        terminal.notice(event.message);
        break;
      case 'warning':
        terminal.warn(event.message);
        break;
      case 'loading':
        terminal.loading(event.attempt);
        break;
      case 'ready':
        terminal.ready(event.generation, event.manifest, event.durationMs);
        break;
      case 'update':
        terminal.update(
          event.files,
          event.generation,
          event.summary,
          event.durationMs,
        );
        break;
      case 'diagnostics':
        terminal.error(
          event.files,
          event.attempt,
          event.diagnostics,
          event.keptGeneration,
        );
        break;
      case 'runtime':
        terminal.runtime(event.status);
        break;
      case 'output':
        if (event.stream === 'stdout') terminal.childStdout(event.line);
        else terminal.childStderr(event.line);

        break;
    }
  };

  let service: DevService | undefined;
  let signalCount = 0;
  let resolveStopped!: () => void;
  let shutdownError: unknown;
  let result: number = exitCodes.ok;
  const reported = new Set<unknown>();
  const reportError = (error: unknown) => {
    result = exitCodes.fatal;

    if (reported.has(error)) return;

    reported.add(error);
    const message = error instanceof Error ? error.message : String(error);
    const details =
      error instanceof DevStartError && error.lock
        ? `\n         Lock: ${error.lock.path}\n         If no relate dev is running for this project, remove that file and retry.`
        : '';

    options.stderr.write(
      `  ${color ? '\u001b[31merror\u001b[39m' : 'error'}  ${message}${details}\n`,
    );
  };
  // A signal can arrive while browser opening is pending. Always settle without
  // rejecting; report failures once control returns to the command adapter.
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const shutdown = async () => {
    try {
      await service?.close({ immediate: signalCount > 1 });
    } catch (error) {
      shutdownError = error;
    } finally {
      resolveStopped();
    }
  };
  const onSignal = () => {
    signalCount += 1;
    void shutdown();
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

  try {
    service = await startDev({
      cwd: options.cwd,
      env: options.env,
      config: args.config,
      port: args.port,
      runtime: args.runtime,
      seed: args.seed,
      rotateMcpToken: args.rotateMcpToken,
      evalTimeoutMs: args.evalTimeoutMs,
      allowedOrigins: args.allowedOrigins,
      onEvent,
      isOutputSaturated: (stream) =>
        (options[stream].writableLength ?? 0) > 1_000_000,
    });

    // Preserve Node's default signal behavior until startup has completed.
    for (const signal of signals) process.on(signal, onSignal);

    if (service.kind === 'existing') {
      options.stdout.write(
        [
          `Relate dev is already running for ${service.project.root}`,
          `Inspector  ${service.inspectorUrl}`,
          ...(service.mcpCommand ? [`MCP        ${service.mcpCommand}`] : []),
          ...(args.quiet
            ? []
            : [
                `Config     ${service.project.configPath}`,
                `PID        ${service.pid}`,
                'Use the existing server; stop it with Ctrl+C in its owning terminal to restart.',
              ]),
          '',
        ].join('\n'),
      );
    }

    if (args.open && !signalCount) {
      try {
        await openBrowser(service.inspectorUrl);
      } catch (error) {
        terminal!.warn(`Could not open a browser: ${(error as Error).message}`);
      }
    }

    if (service.kind === 'started') await stopped;

    if (shutdownError !== undefined) reportError(shutdownError);
  } catch (error) {
    reportError(error);
  } finally {
    for (const signal of signals) process.off(signal, onSignal);

    try {
      await service?.close();
    } catch (error) {
      reportError(error);
    }
  }

  return result;
}
