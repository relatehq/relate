import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createAttemptRunner } from '@relate/cli';
import type { BuildResult } from '../src/dev/build.js';

it('discards a successful bundle when shutdown cancels its in-flight build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relate-attempt-cancel-'));
  const directory = join(root, 'attempt-1');
  let finish!: (result: BuildResult) => void;
  const build = new Promise<BuildResult>((resolve) => {
    finish = resolve;
  });
  const runner = createAttemptRunner({
    projectRoot: root,
    configPath: join(root, 'relate.config.ts'),
    evalTimeoutMs: 1000,
    env: process.env,
    writeStdout() {},
    writeStderr() {},
    builder: {
      build: () => build,
      discard: async (attempt) => {
        await rm(join(root, `attempt-${attempt}`), {
          recursive: true,
          force: true,
        });
      },
      dispose: async () => {},
    },
  });

  try {
    const pending = runner.start();

    await runner.stop();
    await mkdir(directory);
    finish({ ok: true, bundlePath: join(directory, 'app.mjs'), inputs: [] });
    expect(await pending).toEqual({ kind: 'cancelled', attempt: 1 });
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await runner.stop();
    await rm(root, { recursive: true, force: true });
  }
});
