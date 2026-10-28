import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bind, defineApp } from 'relate';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import { datafusion } from '@relate/connector-datafusion';
import { expect, it } from 'vitest';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import { testCreation } from '../../../tests/support/activity.js';
import { writeParquet } from './parquet.js';

it('authorizes objects, dependencies and datasets before DataFusion executes; keeps evidence portable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-datafusion-host-'));
  const connection = datafusion({ connectionId: 'host' });

  try {
    const path = join(directory, 'events.parquet');

    await writeParquet(
      path,
      [
        { name: 'customerId', kind: 'string', nullable: false },
        { name: 'amount', kind: 'int64', nullable: false },
        { name: 'secret', kind: 'string', nullable: false },
      ],
      [
        ['acme', 9007199254740993n, 'private'],
        ['acme', 2n, 'private'],
        ['hidden', 999n, 'private'],
      ],
    );
    const { graph, Customer, Events } = createAnalyticalGraph();
    const model = compile(graph);
    const store = createMemoryStore();
    const scope = {
      graphId: graph.id,
      definitionRevision: model.definitionRevision,
    };

    await store.install(scope.graphId, scope.definitionRevision);
    await store.native!.transaction(scope, (transaction) =>
      transaction.insert(
        {
          objectDefinitionId: Customer.id,
          objectId: 'one',
          createdAt: 0,
          values: { 'customer.external': 'acme', 'customer.label': 'Acme' },
        },
        testCreation(),
      ),
    );
    let statements = 0;
    const source = connection.parquet(path);
    const resource = {
      ...source,
      connection: {
        ...connection,
        analytics: {
          ...connection.analytics,
          execute(...args: Parameters<typeof connection.analytics.execute>) {
            statements++;

            return connection.analytics.execute(...args);
          },
        },
      },
    };
    const runtime = await startApp(
      defineApp({
        graph,
        setup: () => ({ store, bindings: [bind(Events, resource)] }),
      }),
    );

    try {
      const request = {
        select: ['label', 'count'],
        compute: { total: { sql: 'SELECT SUM(amount) FROM self.events' } },
      };

      for (const roles of [[], ['reader', 'private'], ['reader', 'analyst']]) {
        const result = await runtime
          .operations({ id: 'denied', roles, claims: {} })
          .get('customer', 'one', { select: ['label', 'count'] });

        expect(JSON.stringify(result)).not.toContain('9007199254740995');
        expect(statements).toBe(0);
      }

      const actor = runtime.operations({
        id: 'allowed',
        roles: ['reader', 'analyst', 'private'],
        claims: {},
      });
      const result = await actor.get('customer', 'one', request);

      expect(result).toMatchObject({
        status: 'ok',
        data: { label: 'Acme', count: '2', total: '9007199254740995' },
      });
      expect(statements).toBe(1);
      expect(JSON.stringify(result)).not.toContain(directory);
      const page = await actor.query('customer', request);

      expect(page.data[0]!.data).toEqual(
        result.status === 'ok' ? result.data : {},
      );
      expect(statements).toBe(2);
      await runtime.host.flushActivity();
      const records = (
        await runtime.host.activity.operations.list()
      ).entries.filter((row) => row.kind === 'get' || row.kind === 'query');

      expect(
        records.some(
          (row) => row.details.analytical?.stages.execution?.count === 1,
        ),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  } finally {
    await connection.close();
    await rm(directory, { recursive: true, force: true });
  }
});
