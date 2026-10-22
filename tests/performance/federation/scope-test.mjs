import assert from 'node:assert/strict';
import { openFixture } from './fixture.mjs';
import { openTransport } from './transports.mjs';
import { openRelate } from './relate-adapter.mjs';
import { openMultiRelate } from './multi-adapter.mjs';
import { normalize } from './queries.mjs';
import { createMemoryStore } from '@relate/runtime';
import { scopePlan } from './scope-executor.mjs';
import { since, until } from './queries.mjs';

const fixture = await openFixture(40, 1000);

try {
  for (const kind of ['neon', 'child', 'http']) {
    const engine = await openTransport(kind, fixture.config);

    try {
      for (const [scenario, open] of [
        ['ranking-db', openRelate],
        ['multi', openMultiRelate],
      ]) {
        const store = createMemoryStore();

        for (const variant of [
          'native',
          'slot-scan',
          'scope-scan',
          'scope-federated',
        ]) {
          const captures = [];
          const host = await open(
            fixture,
            variant === 'native' ? null : engine,
            store,
            {
              scope: variant.startsWith('scope'),
              mode: variant.endsWith('scan') ? 'scan' : 'federated',
              explain: true,
              onExecution: (capture) => captures.push(capture),
            },
          );

          try {
            assert.deepEqual(
              normalize((await host.query()).rows),
              host.expected,
            );

            if (variant.startsWith('scope')) {
              assert.equal(captures.length, 1);
              assert.equal(captures[0].candidateCount, 32);
              assert.equal(captures[0].statementCount, 1);

              if (variant === 'scope-federated')
                assert.match(captures[0].plan, /GROUP BY/);
            }

            console.log(kind, scenario, variant, 'passed');
          } finally {
            await host.close();
          }
        }
      }

      // One request cannot see another request's Arrow authorization tables.
      const scopes = Array.from({ length: 4 }, (_, i) => ({
        candidateIds: [`object-${i}`],
        scopes: [
          {
            keyCount: 1,
            maskCount: 1,
            rows: [{ rowIndex: 0, values: [`key-${i}`], valid: [i % 2 === 0] }],
          },
        ],
        sql: 'SELECT a.object_id, s.k0, s.m0 FROM authorized a JOIN scope_0 s ON a.row_index = s.row_index',
      }));
      const concurrent = await Promise.all(
        scopes.map((request) => engine.query(request)),
      );

      for (let i = 0; i < 4; i++)
        assert.deepEqual(concurrent[i].rows, [
          { object_id: `object-${i}`, k0: `key-${i}`, m0: i % 2 === 0 },
        ]);

      await assert.rejects(engine.query({ sql: 'SELECT * FROM authorized' }));
      // Duplicate correlation keys remain distinct object slots, including masks.
      const resource = {},
        sources = new WeakMap([
          [
            resource,
            {
              table: 'file_events',
              columns: { customer: 'customer', type: 'type', at: 'at' },
            },
          ],
        ]);
      const compare = (column, op, value) => ({
        kind: 'compare',
        op,
        left: { kind: 'column', column, type: { type: 'string' } },
        right: { kind: 'value', value: { type: 'string', value } },
      });
      const masked = scopePlan(
        [
          {
            fields: [{}],
            rowIndexes: [0, 1],
            query: {
              resource,
              keys: [{ type: { type: 'string' } }],
              correlation: [{ column: 'customer', key: 0 }],
              slots: [false, true].map((valid) => ({
                values: [{ type: 'string', value: '00000001' }],
                valid: [valid],
              })),
              aggregates: [
                {
                  aggregate: 'count',
                  argument: '*',
                  distinct: false,
                  result: { type: 'int64', nullable: false },
                  predicate: {
                    kind: 'boolean',
                    op: 'and',
                    args: [
                      compare('type', '=', 'login'),
                      compare('at', '>=', since),
                      compare('at', '<', until),
                    ],
                  },
                },
              ],
            },
          },
        ],
        [{ id: 'first' }, { id: 'second' }],
        sources,
      );
      const maskedResult = await engine.query(masked);

      assert.equal(maskedResult.rows[0].b0_v0 ?? null, null);
      assert.equal(
        maskedResult.rows[1].b0_v0,
        fixture.expected('bulk').find((row) => row.key === '00000001')
          .login_count,
      );
      await assert.rejects(
        engine.query({
          ...scopes[0],
          scopes: [
            {
              ...scopes[0].scopes[0],
              rows: [{ rowIndex: 1, values: ['x'], valid: [true] }],
            },
          ],
        }),
      );

      const captures = [];
      let afterRead;
      const tracked = {
        ...engine,
        async query(request) {
          const result = await engine.query(request);

          if (afterRead) await afterRead();

          return result;
        },
      };
      const host = await openMultiRelate(
        fixture,
        tracked,
        createMemoryStore(),
        {
          scope: true,
          explain: true,
          onExecution: (value) => captures.push(value),
        },
      );

      try {
        const denied = await host.rawQuery(
          {},
          { id: 'denied', roles: [], claims: { portfolio: 'north' } },
        );

        assert.deepEqual(denied.data, []);
        assert.equal(captures.length, 0);
        const noFinance = {
          id: 'no-finance',
          roles: ['employee'],
          claims: { portfolio: 'north' },
        };

        await assert.rejects(
          async () => await host.rawQuery({}, noFinance),
          (error) => error.code === 'invalid-request',
        );
        assert.equal(captures.length, 0);
        const { paidTotal, ...allowedCompute } = host.request.compute;
        const ordinary = await host.rawQuery(
          { compute: allowedCompute },
          noFinance,
        );

        assert.equal(ordinary.data.length, 25);
        assert(
          ordinary.data.every((row) => !Object.hasOwn(row.data, 'paidTotal')),
        );
        assert(!captures.at(-1).sql.includes('invoices'));
        const empty = await host.rawQuery({ where: { key: 'absent' } });

        assert.deepEqual(empty.data, []);
        assert.equal(captures.length, 1);
        await assert.rejects(
          async () =>
            await host.rawQuery({
              compute: {
                loginCount: {
                  sql: 'SELECT COUNT(*) FROM self.events WHERE customer = self.key',
                },
              },
            }),
          /Per-object predicates/,
        );

        // Change object authorization after source execution but before publication.
        const key = host.expected[0].key;
        const record = fixture.records.find((row) => row.key === key);
        const previous = record.portfolio;

        afterRead = async () => {
          record.portfolio = 'south';
          await host.refresh(key);
        };

        try {
          const changed = await host.rawQuery();

          assert(!changed.data.some((row) => row.data.key === key));
          assert.equal(changed.data.length, 25);
        } finally {
          afterRead = undefined;
          record.portfolio = previous;
          await host.refresh(key);
        }

        // Evidence still carries the original resource binding and dependencies.
        const result = await host.rawQuery();

        for (const row of result.data) {
          assert.equal(row.meta.fields.loginCount.source, 'computed');
          assert.equal(
            row.meta.fields.loginCount.inputs[0].datasetId,
            'federation.file-events',
          );
          assert.equal(
            row.meta.fields.paidTotal.inputs[0].datasetId,
            'federation.invoices',
          );
          assert.equal(
            row.meta.fields.loginCount.dependencies.key.status,
            'available',
          );
        }

        console.log(
          kind,
          'scope isolation, denied access, revocation, evidence passed',
        );
      } finally {
        await host.close();
      }
    } finally {
      await engine.close();
    }
  }
} finally {
  await fixture.close();
}
