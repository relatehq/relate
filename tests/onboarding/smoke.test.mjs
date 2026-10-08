import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const launcher = 'scripts/examples/run.mjs';

test(
  'hello world builds its dependencies and prints the authorized result',
  { timeout: 120000 },
  async () => {
    const { stdout, stderr } = await execute(process.execPath, [
      launcher,
      'hello-world',
    ]);

    assert.equal(JSON.parse(stdout).data.name, 'Ada');
    assert.match(stderr, /Preparing hello world/);
    assert.doesNotMatch(stderr, /vite|transforming|built in/);
  },
);

test(
  'SQLite example runs on the selected Node version',
  { timeout: 120000 },
  async () => {
    const { stdout } = await execute(process.execPath, [
      launcher,
      'customer-accounts',
    ]);

    assert.match(
      stdout,
      /The employee can read Northwind; the other portfolio is hidden/,
    );
  },
);

test(
  'browser demo serves its UI, enforces roles, replays receipts and shuts down',
  { timeout: 120000 },
  async () => {
    const child = spawn(
      process.execPath,
      [launcher, 'customer-workspace', '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const closed = once(child, 'close');
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    let url;
    let inspector;

    try {
      const deadline = Date.now() + 90000;

      while (!url && Date.now() < deadline) {
        url = /Ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];

        if (child.exitCode !== null) assert.fail(output);

        if (!url) await delay(50);
      }

      assert.ok(url, output);
      assert.doesNotMatch(output, /transforming|built in|Relate dev\n/);
      const page = await fetch(url);

      assert.equal(page.status, 200);
      assert.match(await page.text(), /Customer workspace/);
      const config = await (await fetch(`${url}/config`)).json();

      inspector = new URL(config.inspectorUrl).origin;
      assert.equal((await fetch(inspector)).status, 200);
      const request = async (body) => {
        const response = await fetch(`${url}/api`, {
          method: 'POST',
          headers: { Origin: url, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        assert.equal(response.status, 200);

        return response.json();
      };
      const ana = await request({ operation: 'read', actor: 'ana' });
      const fin = await request({ operation: 'read', actor: 'fin' });

      assert.equal(
        ana.invoices.data[0].meta.fields.totalMinor.status,
        'forbidden',
      );
      assert.deepEqual(
        fin.invoices.data.map((invoice) => invoice.data.totalMinor).sort(),
        [125000, 480000],
      );
      const review = {
        operation: 'review',
        actor: 'ana',
        note: 'Onboarding check',
        idempotencyKey: 'smoke-review',
      };
      const receipt = await request(review);

      assert.equal(receipt.state, 'succeeded');
      assert.deepEqual(await request(review), receipt);
    } finally {
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      const [code] = await closed;

      clearTimeout(timer);
      assert.equal(code, 130, output);
    }

    await assert.rejects(fetch(url));
    await assert.rejects(fetch(inspector));
  },
);

test(
  'Postgres example uses the configured test database',
  {
    timeout: 120000,
    skip: !process.env.RELATE_TEST_DATABASE_URL,
  },
  async () => {
    const { stdout } = await execute(process.execPath, [launcher, 'postgres'], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.RELATE_TEST_DATABASE_URL,
      },
    });

    assert.match(stdout, /employee-read/);
  },
);
