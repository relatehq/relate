import assert from 'node:assert/strict';
import { openFixture } from './fixture.mjs';
import { openTransport } from './transports.mjs';
import { normalize, querySql } from './queries.mjs';
import { openRelate } from './relate-adapter.mjs';

const fixture = await openFixture(40, 1000);
const outcomes = [];

try {
  for (const scenario of [
    'ranking-db',
    'ranking-file',
    'multi',
    'selective',
    'bulk',
  ]) {
    assert.deepEqual(
      normalize((await fixture.native(scenario)).rows),
      fixture.expected(scenario),
    );
  }

  for (const kind of ['neon', 'child', 'http']) {
    const engine = await openTransport(kind, fixture.config);

    try {
      for (const mode of ['scan', 'federated']) {
        for (const scenario of [
          'ranking-db',
          'ranking-file',
          'multi',
          'selective',
          'bulk',
        ]) {
          console.log(kind, mode, scenario);
          const actual = await engine.query({ mode, sql: querySql(scenario) });

          assert.deepEqual(normalize(actual.rows), fixture.expected(scenario));
        }

        // Bulk includes empty customers, rejected portfolios, null invoice inputs,
        // dates outside the requested window and tied counts.
        const missing = await engine.query({
          mode,
          sql: "SELECT key FROM customers WHERE key = 'missing'",
        });

        assert.deepEqual(missing.rows, []);
      }

      await assert.rejects(engine.query({ sql: 'SELECT * FROM absent_table' }));
      await assert.rejects(engine.query({ sql: 'SELECT 1', mode: 'invalid' }));
      await assert.rejects(engine.query({ sql: 'SELECT 1', timeoutMs: 0 }));
      const recovered = await engine.query({ sql: 'SELECT 1 AS value' });

      assert.deepEqual(recovered.rows, [{ value: 1 }]);
      const replies = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          engine.query({ sql: `SELECT ${i} AS value` }),
        ),
      );

      assert.deepEqual(
        replies.map((r) => r.rows[0].value),
        [0, 1, 2, 3],
      );
      // JSON integer fidelity is explicit: large integers must be returned as strings.
      const wide = await engine.query({
        sql: 'SELECT CAST(9223372036854775807 AS VARCHAR) AS value',
      });

      assert.equal(wide.rows[0].value, '9223372036854775807');
      const snapshot = await engine.query('snapshot');

      assert(snapshot.snapshotMs > 0);
      assert.deepEqual(
        normalize((await engine.query({ sql: querySql('multi', true) })).rows),
        fixture.expected('multi'),
      );
      const host = await openRelate(fixture, engine);

      try {
        assert.deepEqual(normalize((await host.query()).rows), host.expected);
      } finally {
        await host.close();
      }

      await assert.rejects(
        engine.query({
          sql: 'SELECT COUNT(*) FROM file_events a CROSS JOIN file_events b CROSS JOIN file_events c WHERE a.customer <> b.customer',
          timeoutMs: 1,
        }),
      );
      assert.deepEqual(
        (await engine.query({ sql: 'SELECT 1 AS value' })).rows,
        [{ value: 1 }],
      );

      if (kind !== 'neon') {
        const rejected = assert.rejects(
          engine.query({
            sql: 'SELECT COUNT(*) FROM file_events a CROSS JOIN file_events b CROSS JOIN file_events c',
          }),
        );

        process.kill(engine.pid, 'SIGKILL');
        await rejected;
        const restarted = await openTransport(kind, fixture.config);

        try {
          assert.deepEqual(
            (await restarted.query({ sql: 'SELECT 1 AS value' })).rows,
            [{ value: 1 }],
          );
        } finally {
          await restarted.close();
        }
      }

      outcomes.push({ kind, status: 'passed' });
    } finally {
      await engine.close();
    }
  }

  const host = await openRelate(fixture);

  try {
    assert.deepEqual(normalize((await host.query()).rows), host.expected);
  } finally {
    await host.close();
  }

  console.log(
    JSON.stringify({ outcomes, postgresBaseline: 'passed' }, null, 2),
  );
} finally {
  await fixture.close();
}
