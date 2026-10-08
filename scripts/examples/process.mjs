import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Quiet preparation and visible failures. Build steps opt into processTree so
 * cancellation reaches their workers even in verbose mode. Examples stay in the
 * terminal session and own their graceful cleanup; their descendants may include
 * a browser, so finishing an example must not kill its whole process group.
 */
export async function runCommand(
  command,
  args,
  { quiet = false, processTree = false, ...options } = {},
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
      if (!processTree) child.kill(signal);
      else if (process.platform === 'win32' && signal === 'SIGKILL') {
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
    if (processTree) killTree('SIGTERM');
    else child?.kill('SIGTERM');

    timer = setTimeout(() => killTree('SIGKILL'), 8000);
    timer.unref();
  };

  try {
    child = spawn(command, args, {
      ...options,
      detached: processTree && process.platform !== 'win32',
      stdio: log ? ['ignore', log.fd, log.fd] : 'inherit',
    });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop);
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

    if (cancelled && processTree) killTree('SIGKILL');

    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    await log?.close();

    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
