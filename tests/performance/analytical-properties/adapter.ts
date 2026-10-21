import assert from 'node:assert/strict';
import type { openObjects, Row } from './model.js';
import { scenarios } from './scenarios.js';
import type { Request } from './scenarios.js';
import type { Trace } from './timing.js';

export const unavailableMeasurements = [
  'database-server-execution',
  'generated-sql-replay',
  'runtime-computed-order',
  'single-operation-full-scope',
];

/** Real public reads. Ranking remains an explicitly labeled benchmark-side sort. */
export function createAdapter(
  objects: Awaited<ReturnType<typeof openObjects>>,
) {
  return {
    async query(request: Request, trace: Trace): Promise<Row[]> {
      assert(
        Object.values(scenarios).includes(request),
        'Only the three benchmark requests are supported',
      );
      objects.begin(trace);
      const computes = 'compute' in request;
      const ranks = 'orderBy' in request;
      const candidates = await trace.measure(
        'public-query-pages',
        'real',
        async () => {
          const query = objects.customer.query({
            select: ['name', 'key'],
            where: { portfolio: 'north' },
            ...(computes ? { compute: request.compute } : {}),
            limit: ranks ? 100 : request.limit,
          });
          const rows = [];

          if (ranks) {
            for await (const row of query) rows.push(row);
          } else rows.push(...(await query).data);

          return rows;
        },
      );

      trace.counters.candidatesAdmitted = candidates.length;
      let rows: Row[] = candidates.map((row) => {
        const data: Readonly<Record<string, unknown>> = row.data;

        assert.equal(typeof data.name, 'string');

        if (computes) {
          assert.equal(
            typeof data.loginCount,
            'string',
            'Computed count was withheld',
          );
          assert(
            data.lastLogin === null || typeof data.lastLogin === 'string',
            'Computed timestamp was withheld',
          );

          return {
            id: row.id,
            data: {
              name: data.name as string,
              loginCount: data.loginCount as string,
              lastLogin: data.lastLogin as string | null,
            },
          };
        }

        return { id: row.id, data: { name: data.name as string } };
      });

      if (ranks)
        rows = await trace.measure('benchmark-local-sort', 'real', () => {
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
