import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Quiet preparation, visible failures, and cancellation of the owned process tree. */
export async function runCommand(
  command,
  args,
  { quiet = false, ...options } = {},
) {
  const directory = quiet
    ? await mkdtemp(join(tmpdir(), 'relate-build-'))
    : undefined;
  const log = directory
    ? await open(join(directory, 'output.log'), 'w+')
    : undefined;
  let timer;
  let cancelled = false;
  let child;
  const killTree = (signal) => {
    if (!child?.pid) return;

    try {
      if (process.platform === 'win32' && signal === 'SIGKILL') {
        const killer = spawn(
          'taskkill',
          ['/pid', String(child.pid), '/T', '/F'],
          { stdio: 'ignore' },
        );

        killer.on('error', () => child.kill(signal));
      } else if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const stop = () => {
    if (cancelled) return killTree('SIGKILL');

    cancelled = true;

    // The running example owns graceful cleanup of its children.
    // Build subprocesses have no such protocol, so signal the entire group.
    if (quiet) killTree('SIGTERM');
    else child?.kill('SIGTERM');

    timer = setTimeout(() => killTree('SIGKILL'), 8000);
    timer.unref();
  };

  try {
    child = spawn(command, args, {
      ...options,
      detached: process.platform !== 'win32',
      stdio: log ? ['ignore', log.fd, log.fd] : 'inherit',
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });

    if (code !== 0 && log && !cancelled)
      process.stderr.write(
        await readFile(join(directory, 'output.log'), 'utf8'),
      );

    return cancelled ? 130 : code;
  } finally {
    clearTimeout(timer);

    if (cancelled) killTree('SIGKILL');

    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await log?.close();

    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
