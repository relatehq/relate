import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const moduleUrl = new URL('./process.mjs', import.meta.url).href;

function run(source, quiet) {
  return execute(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { runCommand } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runCommand(process.execPath, ['-e', ${JSON.stringify(source)}], { quiet: ${quiet} });
  `,
  ]);
}

test('successful preparation hides both output streams', async () => {
  const result = await run(
    'console.log("build output"); console.error("build notice")',
    true,
  );

  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('failed preparation shows diagnostics and preserves the exit code', async () => {
  await assert.rejects(
    run(
      'console.log("build context"); console.error("compiler failure"); process.exitCode = 7',
      true,
    ),
    (error) => {
      assert.equal(error.code, 7);
      assert.match(error.stderr, /build context/);
      assert.match(error.stderr, /compiler failure/);

      return true;
    },
  );
});

test('verbose preparation and runtime output stay visible', async () => {
  const result = await run(
    'console.log("result"); console.error("warning")',
    false,
  );

  assert.match(result.stdout, /result/);
  assert.match(result.stderr, /warning/);
});

for (const signal of ['SIGINT', 'SIGHUP'])
  for (const quiet of [true, false])
    test(
      `${signal} stops the ${quiet ? 'quiet' : 'verbose'} preparation subprocess tree`,
      { timeout: 15000, skip: process.platform === 'win32' },
      async () => {
        const { spawn } = await import('node:child_process');
        const { mkdtemp, readFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { once } = await import('node:events');
        const { setTimeout: delay } = await import('node:timers/promises');
        const directory = await mkdtemp(join(tmpdir(), 'relate-cancel-test-'));
        const marker = join(directory, 'pid');
        const source = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
        const child = spawn(process.execPath, [
          '--input-type=module',
          '-e',
          `
    import { runCommand } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runCommand(process.execPath, ['-e', ${JSON.stringify(source)}], { quiet: ${quiet}, processTree: true });
  `,
        ]);
        const closed = once(child, 'close');
        let pid;

        try {
          const deadline = Date.now() + 5000;

          while (!pid && Date.now() < deadline) {
            pid = Number(await readFile(marker, 'utf8').catch(() => ''));

            if (!pid) await delay(20);
          }

          assert.ok(pid, 'preparation child started');
          child.kill(signal);
          assert.equal((await closed)[0], 130);

          // Reaping a grandchild may lag behind its parent by a scheduling turn.
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              process.kill(pid, 0);
            } catch {
              pid = undefined;
              break;
            }

            await delay(20);
          }

          assert.equal(
            pid,
            undefined,
            'preparation left no running grandchild',
          );
        } finally {
          child.kill('SIGKILL');

          if (pid) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }

          await rm(directory, { recursive: true, force: true });
        }
      },
    );

test(
  'graceful example shutdown leaves a browser-like descendant running',
  {
    timeout: 15000,
    skip: process.platform === 'win32',
  },
  async () => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { setTimeout: delay } = await import('node:timers/promises');
    const source = `
    const { spawn } = require('node:child_process');
    const browser = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.on('SIGTERM', () => process.exit(0));
    console.log(browser.pid);
    setInterval(() => {}, 1000);
  `;
    const runner = spawn(process.execPath, [
      '--input-type=module',
      '-e',
      `
    import { runCommand } from ${JSON.stringify(moduleUrl)};
    process.exitCode = await runCommand(process.execPath, ['-e', ${JSON.stringify(source)}]);
  `,
    ]);
    const closed = once(runner, 'close');
    let output = '';

    runner.stdout.on('data', (chunk) => {
      output += chunk;
    });
    let pid;

    try {
      const deadline = Date.now() + 5000;

      while (!output.includes('\n') && Date.now() < deadline) await delay(20);

      pid = Number(output.trim());
      assert.ok(pid, 'browser-like descendant started');
      runner.kill('SIGINT');
      assert.equal((await closed)[0], 130);
      assert.doesNotThrow(() => process.kill(pid, 0));
    } finally {
      runner.kill('SIGKILL');

      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  },
);
