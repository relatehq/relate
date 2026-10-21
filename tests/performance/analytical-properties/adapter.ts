import assert from 'node:assert/strict';
import type { openObjects, Row, Values } from './model.js';
import { scenarios } from './scenarios.js';
import type { Request } from './scenarios.js';
import type { Trace } from './timing.js';

export const mockedStages = [
  'analytical-preparation',
  'analytical-execution',
  'computed-finalization',
] as const;

export const unavailableMeasurements = [
  'candidates-scanned',
  'object-storage-round-trip',
  'analytical-queue-wait',
  'connection-acquisition',
  'database-server-execution',
  'generated-sql',
];

/** Replace this adapter with Customer.query(request) and real stage instrumentation when available. */
export function createAdapter(
  objects: Awaited<ReturnType<typeof openObjects>>,
  values: Map<string, Values>,
) {
  return {
    async query(request: Request, trace: Trace): Promise<Row[]> {
      assert(
        Object.values(scenarios).some(
          (scenario) => JSON.stringify(scenario) === JSON.stringify(request),
        ),
        'Adapter only supports the three declared benchmark requests',
      );
      const computes = 'compute' in request;
      const ranks = 'orderBy' in request;

      if (computes)
        await trace.measure('analytical-preparation', 'mock', () => undefined);

      const before = objects.sourceFetches();
      const candidates = await trace.measure(
        'object-query',
        'real',
        async () => {
          const query = objects.customer.query({
            select: ['name', 'key'],
            where: { portfolio: 'north' },
            limit: ranks ? 100 : request.limit,
          });
          const rows = [];

          if (ranks) {
            for await (const row of query) rows.push(row);
          } else rows.push(...(await query).data);

          return rows;
        },
      );

      trace.counters.sourceFetches = objects.sourceFetches() - before;
      trace.counters.candidatesAdmitted = candidates.length;
      trace.counters.analyticalStatements = 0;
      let rows: Row[] = candidates.map((row) => {
        assert.equal(typeof row.data.name, 'string');

        return { id: row.id, data: { name: row.data.name! } };
      });

      if (computes)
        rows = await trace.measure('analytical-execution', 'mock', () =>
          candidates.map((row) => {
            assert.equal(typeof row.data.key, 'string');

            return {
              id: row.id,
              data: {
                name: row.data.name!,
                ...(values.get(row.data.key!) ?? {
                  loginCount: '0',
                  lastLogin: null,
                }),
              },
            };
          }),
        );

      if (computes)
        rows = await trace.measure('computed-finalization', 'mock', () => {
          if (ranks)
            rows.sort((a, b) => {
              const difference =
                BigInt(b.data.loginCount!) - BigInt(a.data.loginCount!);

              return difference === 0n
                ? a.id < b.id
                  ? -1
                  : a.id > b.id
                    ? 1
                    : 0
                : difference > 0n
                  ? 1
                  : -1;
            });

          return rows.slice(0, request.limit);
        });

      trace.counters.objectsReturned = rows.length;

      return rows;
    },
  };
}
