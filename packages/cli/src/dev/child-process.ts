/**
 * Parent side of every child `relate dev` forks (the compile worker and the
 * runtime host): prefixed output with back-pressure, an `exited` promise that
 * also settles when the spawn itself fails, and graceful-then-forced
 * termination. `child-support.ts` is the matching code inside the children.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { LinePrefixer } from './streams.js';

export interface ChildOutput {
  readonly prefix: string;
  readonly write: (line: string) => void;
  /** Lines are counted and dropped while the sink reports back-pressure. */
  readonly isSaturated?: () => boolean;
}

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Set when the process never started; Node emits `error` but no `exit`. */
  readonly spawnError?: Error;
}

export interface ManagedChild {
  readonly process: ChildProcess;
  /** Settles once the process exits or fails to spawn; never rejects. */
  readonly exited: Promise<ChildExit>;
  readonly hasExited: boolean;
  /**
   * Ask the child to stop (SIGTERM unless `ask` is given), SIGKILL it after
   * `graceMs`, and resolve once it has exited.
   */
  terminate(graceMs: number, ask?: () => void): Promise<void>;
  /** SIGKILL now and resolve once it has exited. */
  kill(): Promise<void>;
}

export function spawnChild(options: {
  readonly modulePath: string;
  readonly argument: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly serialization: 'json' | 'advanced';
  readonly stdout: ChildOutput;
  readonly stderr: ChildOutput;
  /** Every raw stderr chunk, before it is split into lines. */
  readonly onStderr?: (chunk: Buffer) => void;
}): ManagedChild {
  // Throws synchronously for invalid arguments; callers report that.
  const child = fork(options.modulePath, [options.argument], {
    cwd: options.cwd,
    env: options.env,
    execArgv: ['--enable-source-maps'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: options.serialization,
  });
  let hasExited = false;
  const exited = new Promise<ChildExit>((resolve) => {
    const settle = (exit: ChildExit) => {
      hasExited = true;
      resolve(exit);
    };

    child.once('exit', (code, signal) => settle({ code, signal }));
    // `error` also reports failed kills and sends; only a missing pid means
    // the process never started.
    child.on('error', (error) => {
      if (child.pid === undefined)
        settle({ code: null, signal: null, spawnError: error });
    });
  });
  const stdout = new LinePrefixer(options.stdout);
  const stderr = new LinePrefixer(options.stderr);

  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => {
    options.onStderr?.(chunk);
    stderr.push(chunk);
  });
  child.stdout?.on('end', () => stdout.end());
  child.stderr?.on('end', () => stderr.end());

  return {
    process: child,
    exited,
    get hasExited() {
      return hasExited;
    },
    async terminate(graceMs, ask = () => child.kill('SIGTERM')) {
      if (hasExited) return;

      const deadline = setTimeout(() => child.kill('SIGKILL'), graceMs);

      ask();
      await exited;
      clearTimeout(deadline);
    },
    async kill() {
      if (hasExited) return;

      child.kill('SIGKILL');
      await exited;
    },
  };
}
