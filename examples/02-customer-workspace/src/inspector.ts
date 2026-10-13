import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface Inspector {
  ready: Promise<{ url: string; reused: boolean }>;
  exited: Promise<void>;
  stop(force?: boolean): Promise<void>;
}

/** The CLI's complete terminal lines carry its local bootstrap link. */
export function watchInspector(
  child: ChildProcessWithoutNullStreams,
  onOutput?: (line: string) => void,
): Inspector {
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  const ready = new Promise<{ url: string; reused: boolean }>(
    (resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      let reused = false;
      const timeout = setTimeout(
        () => reject(new Error('Inspector startup timed out')),
        30000,
      );
      const clear = () => {
        clearTimeout(timeout);
        lines.close();
      };

      child.once('error', (error) => {
        clear();
        reject(error);
      });
      // 'close' follows the final stdout line; 'exit' can arrive before it.
      child.once('close', () => {
        clear();
        reject(new Error('Inspector exited before startup'));
      });
      lines.on('line', (line) => {
        if (line.startsWith('Relate dev is already running for ')) {
          reused = true;

          return;
        }

        const match =
          /^\s*Inspector\s+(http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+)\s*$/.exec(
            line,
          );

        if (match) {
          clearTimeout(timeout);
          resolve({ url: match[1]!, reused });
        } else onOutput?.(line);
      });
    },
  );

  return {
    ready,
    exited,
    async stop(force = false) {
      // In reuse mode this is only the short-lived CLI child, never the existing owner.
      if (child.exitCode === null && child.signalCode === null)
        child.kill(force ? 'SIGKILL' : 'SIGTERM');

      await exited;
    },
  };
}

export function startInspector(): Inspector {
  const quiet = process.env.RELATE_EXAMPLE_VERBOSE === '0';
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../packages/cli/bin/relate.js', import.meta.url),
      ),
      'dev',
      ...(quiet ? ['--quiet'] : []),
      '--config',
      fileURLToPath(new URL('../relate.config.ts', import.meta.url)),
    ],
    { stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } },
  );

  child.stdin.end();

  if (!quiet) child.stdout.pipe(process.stdout);

  child.stderr.pipe(process.stderr);

  return watchInspector(
    child,
    quiet ? (line) => process.stdout.write(`${line}\n`) : undefined,
  );
}
