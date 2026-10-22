import { afterEach, describe, expect, it } from 'vitest';
import { bind, defineApp } from 'relate';
import { compile } from 'relate/compiler';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import type { AnalyticalResource } from 'relate/connectors';
import type { ObjectReadRequest } from '@relate/protocol';
import { testCreation } from '../activity.js';
import { sqlCorpus } from './index.js';
import { createSqlCorpusGraph, sqlCorpusRows } from './model.js';
import type { SqlCorpusRow } from './model.js';

/** Generation is verified through the real parser, runtime planner and connector, against hand-authored values. */
export function sqlCorpusBackendContract(
  name: string,
  open: (
    rows: readonly SqlCorpusRow[],
  ) => Promise<{ resource: AnalyticalResource; close(): Promise<void> }>,
) {
  describe(name, () => {
    const cleanup: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
    });

    for (const entry of sqlCorpus.filter(
      (entry) => entry.expect.phase !== 'parse',
    )) {
      // Named parameters belong to caller expressions; declarations reject them at startup.
      for (const declared of entry.expect.phase === 'execute' &&
      !entry.parameters
        ? [false, true]
        : [false]) {
        it(`${entry.name} (${declared ? 'declared' : 'caller'})`, async () => {
          const { graph, Events } = createSqlCorpusGraph(entry, declared);
          const model = compile(graph);
          const backing = await open(sqlCorpusRows());

          cleanup.push(() => backing.close());
          const base = backing.resource.connection;
          let statements = 0;
          const resource = {
            ...backing.resource,
            connection: {
              ...base,
              analytics: {
                ...base.analytics,
                execute(...args: Parameters<typeof base.analytics.execute>) {
                  statements++;

                  return base.analytics.execute(...args);
                },
              },
            },
          };
          const store = createMemoryStore();
          const scope = {
            graphId: graph.id,
            definitionRevision: model.definitionRevision,
          };

          await store.install(scope.graphId, scope.definitionRevision);
          await store.native!.transaction(scope, async (transaction) => {
            for (const [id, external, since] of [
              ['acme_before', 'acme', '2026-10-01T00:00:00.000Z'],
              ['acme_late', 'acme', '2026-10-10T00:00:00.000Z'],
              ['empty', 'empty', '2026-10-01T00:00:00.000Z'],
              ['nulls', 'nulls', '2026-10-01T00:00:00.000Z'],
              ['wide', 'wide', '2026-10-01T00:00:00.000Z'],
            ])
              await transaction.insert(
                {
                  objectDefinitionId: 'customer',
                  objectId: id!,
                  createdAt: 1,
                  values: {
                    'customer.external': external!,
                    'customer.since': since!,
                  },
                },
                testCreation(),
              );
          });
          const runtime = await startApp(
            defineApp({
              graph,
              setup: () => ({ store, bindings: [bind(Events, resource)] }),
            }),
          );

          cleanup.push(() => runtime.close());
          const actor = runtime.operations({
            id: 'reader',
            roles: ['reader'],
            claims: {},
          });
          const request: ObjectReadRequest = declared
            ? { select: ['value'] }
            : {
                select: [],
                compute: {
                  value: {
                    sql: entry.sql,
                    ...(entry.parameters
                      ? { parameters: entry.parameters }
                      : {}),
                  },
                },
              };
          const expected = entry.expect;

          if (expected.phase === 'resolve') {
            await expect(
              actor.query('customer', request),
            ).rejects.toMatchObject({
              code: 'invalid-request',
              issues: [expect.objectContaining({ problem: expected.problem })],
            });
            expect(statements).toBe(0);

            return;
          }

          if (expected.phase !== 'execute')
            throw new Error('Parse rejection belongs to the parser contract');

          const page = await actor.query('customer', {
            ...request,
            evidence: 'full',
          });

          expect(
            Object.fromEntries(
              page.data.map((row) => [row.id, row.data.value]),
            ),
          ).toEqual(expected.values);
          expect(statements).toBe(1);

          for (const row of page.data) {
            expect(row.data).toEqual({ value: expected.values[row.id] });
            expect(row.meta.computed).toEqual({ value: expected.resultType });
            expect(row.meta.fields?.value).toMatchObject({
              status: 'available',
              source: 'computed',
              freshness: 'unverified',
            });
          }

          const record = await actor.get('customer', 'acme_before', {
            ...request,
            evidence: 'compact',
          });

          expect(record).toMatchObject({
            status: 'ok',
            data: { value: expected.values.acme_before },
            meta: { computed: { value: expected.resultType } },
          });
          expect(statements).toBe(2);
        });
      }
    }
  });
}
