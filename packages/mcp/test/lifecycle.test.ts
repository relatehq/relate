import { fork, execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, it, onTestFinished } from 'vitest';
import { createDevelopmentExecutor } from '@relate/mcp';
import { createFixture } from './fixture.js';

function kill(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform === 'win32') return true;

  // Orphans may await reaping as zombies on a Linux CI host; they have exited.
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    })
      .trim()
      .startsWith('Z');
  } catch {
    return false;
  }
}

it.skipIf(process.platform === 'win32').each(['timeout', 'abort', 'success'])(
  'bounds %s cleanup when a detached grandchild keeps output pipes open',
  async (mode) => {
    const { binding } = await createFixture(onTestFinished);
    const directory = await mkdtemp(join(tmpdir(), 'mcp-pipe-test-'));
    const infoPath = join(directory, 'info.json');
    let info: { pid: number; cwd: string } | undefined;
    const controller = new AbortController();
    const execution = createDevelopmentExecutor({ timeoutMs: 1000 }).execute({
      graph: binding,
      signal: controller.signal,
      code: `
      const {spawn} = await import('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: ['ignore', 'inherit', 'inherit']});
      (await import('node:fs')).writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({pid: grandchild.pid, cwd: process.cwd()}));
      ${mode === 'success' ? 'return 42;' : 'await new Promise(() => {});'}
    `,
    });

    onTestFinished(async () => {
      controller.abort();
      info ??= JSON.parse(await readFile(infoPath, 'utf8').catch(() => 'null'));

      if (info) kill(info.pid);

      await execution;
      await rm(directory, { recursive: true, force: true });
    });
    await expect
      .poll(
        async () => {
          info = JSON.parse(await readFile(infoPath, 'utf8'));

          return info?.pid;
        },
        { timeout: 3000 },
      )
      .toBeGreaterThan(0);

    if (mode === 'abort') controller.abort();

    let timer: ReturnType<typeof setTimeout>;

    try {
      const outcome = await Promise.race([
        execution,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('execution still hung'), 2500);
        }),
      ]);

      expect(outcome).toMatchObject(
        mode === 'success'
          ? { status: 'succeeded', result: 42 }
          : {
              status: 'failed',
              error: { code: mode === 'abort' ? 'aborted' : 'timeout' },
            },
      );
      await expect(access(info!.cwd)).rejects.toThrow();
    } finally {
      clearTimeout(timer!);
    }
  },
);

it('terminates a CPU-bound execution when its host is killed', async () => {
  const host = fork(new URL('./lifecycle-host.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let info: { pid: number; cwd: string } | undefined;

  onTestFinished(async () => {
    if (host.exitCode === null && host.signalCode === null)
      host.kill('SIGKILL');

    if (info) {
      kill(info.pid);
      await rm(info.cwd, { recursive: true, force: true });
    }
  });
  const message = once(host, 'message');

  [info] = (await message) as [{ pid: number; cwd: string }];
  const exited = once(host, 'exit');

  host.kill('SIGKILL');
  await exited;
  await expect.poll(() => running(info!.pid), { timeout: 2500 }).toBe(false);
}, 10_000);
