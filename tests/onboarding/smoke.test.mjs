import pg from 'pg';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const launcher = 'scripts/examples/run.mjs';

test(
  'todo notes builds its dependencies and lists the created todo',
  { timeout: 120000 },
  async () => {
    const { stdout, stderr } = await execute(process.execPath, [
      launcher,
      'native-objects',
      '--walkthrough',
    ]);

    assert.deepEqual(
      JSON.parse(stdout).map((todo) => todo.title),
      ['Try Relate'],
    );
    assert.match(stderr, /Preparing native objects/);
    assert.doesNotMatch(stderr, /vite|transforming|built in/);
  },
);

test(
  'customer workspace walkthrough prints role reads and review replay',
  { timeout: 120000 },
  async () => {
    const { stdout } = await execute(process.execPath, [
      launcher,
      'connected-sources',
      '--walkthrough',
    ]);

    assert.match(stdout, /"actor": "ana"/);
    assert.match(stdout, /"actor": "fin"/);
    assert.match(stdout, /Review receipt:/);
    assert.match(stdout, /Retried receipt:/);
    assert.match(stdout, /Created review:/);
  },
);

test(
  'Postgres example uses the configured test database',
  {
    timeout: 120000,
    skip: !process.env.RELATE_TEST_DATABASE_URL,
  },
  async () => {
    // This test owns only the explicitly configured disposable test database.
    const database = new pg.Client({
      connectionString: process.env.RELATE_TEST_DATABASE_URL,
    });

    await database.connect();

    try {
      await database.query('DROP SCHEMA IF EXISTS relate CASCADE');
      const { stdout } = await execute(
        process.execPath,
        [launcher, 'persistence', '--walkthrough'],
        {
          env: {
            ...process.env,
            DATABASE_URL: process.env.RELATE_TEST_DATABASE_URL,
          },
        },
      );

      assert.match(stdout, /employee-read/);
    } finally {
      try {
        await database.query('DROP SCHEMA IF EXISTS relate CASCADE');
      } finally {
        await database.end();
      }
    }
  },
);

for (const [name, principal, object, field, expected] of [
  ['native-objects', 'ada', 'Todo', 'title', ['Try Relate']],
  ['connected-sources', 'ana', 'Customer', 'name', ['Mothlight']],
  ['datasets', 'ana', 'Campaign', 'ctr', [0.04, 0.08, 0.15, null]],
  ['persistence', 'ana', 'Customer', 'name', ['Mothlight']],
]) {
  test(
    `${name} starts a seeded Inspector and shuts down`,
    {
      timeout: 120000,
      skip: name === 'persistence' && !process.env.RELATE_TEST_DATABASE_URL,
    },
    async () => {
      const child = spawn(process.execPath, [launcher, name, '--no-open'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(name === 'persistence'
            ? { DATABASE_URL: process.env.RELATE_TEST_DATABASE_URL }
            : {}),
        },
      });
      const closed = once(child, 'close');
      let output = '';

      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      let origin;

      try {
        const deadline = Date.now() + 90000;
        let link;

        while (!link && Date.now() < deadline) {
          link =
            /Inspector\s+(http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]+)/.exec(
              output,
            )?.[1];

          if (child.exitCode !== null) assert.fail(output);

          if (!link) await delay(50);
        }

        assert.ok(link, output);
        assert.doesNotMatch(
          output,
          /already running/,
          'Test must own its Inspector',
        );
        const url = new URL(link);

        origin = url.origin;
        assert.equal((await fetch(origin)).status, 200);
        const session = await fetch(`${origin}/dev/session`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({
            token: new URLSearchParams(url.hash.slice(1)).get('token'),
          }),
        });

        assert.equal(session.status, 204);
        const cookie = session.headers.get('set-cookie').split(';')[0];
        let snapshot;

        do {
          snapshot = await (
            await fetch(`${origin}/dev/snapshot`, { headers: { cookie } })
          ).json();
          assert.notEqual(
            snapshot.runtime?.state,
            'failed',
            JSON.stringify(snapshot),
          );

          if (snapshot.runtime?.state === 'running') break;

          await delay(50);
        } while (Date.now() < deadline);

        assert.equal(snapshot.runtime?.state, 'running');
        const response = await fetch(`${origin}/dev/playground/runs`, {
          method: 'POST',
          headers: { origin, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            principal,
            code: `return graph.objects.${object}.query({ select: ['${field}'] });`,
          }),
        });

        assert.equal(response.status, 200);
        const run = await response.json();

        assert.equal(run.status, 'succeeded', JSON.stringify(run));
        assert.deepEqual(
          run.result.data.map((row) => row.data[field]).sort(),
          expected,
        );
      } finally {
        child.kill('SIGINT');
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        const [code] = await closed;

        clearTimeout(timer);
        assert.equal(code, 130, output);
      }

      await assert.rejects(fetch(origin));
    },
  );
}
