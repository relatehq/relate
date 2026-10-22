import assert from 'node:assert/strict';
import type { openObjects, Row } from './model.js';
import { scenarios } from './scenarios.js';
import type { Request } from './scenarios.js';
import type { Trace } from './timing.js';

export const unavailableMeasurements = [
  'database-server-execution',
  'generated-sql-replay',
];

/** Real public reads, including one scope-first operation for the ranked page. */
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
        'public-query',
        'real',
        async () => {
          const query = objects.customer.query({
            select: ['name', 'key'],
            where: { portfolio: 'north' },
            ...(computes ? { compute: request.compute } : {}),
            ...(ranks ? { orderBy: request.orderBy } : {}),
            limit: request.limit,
          });

          return (await query).data;
        },
      );

      // Both expressions share one association and one slot per authorized
      // object in this fixed workload; there are no unavailable dependencies.
      trace.counters.candidatesAdmitted = computes
        ? trace.counters.computedSlots!
        : candidates.length;
      const rows: Row[] = candidates.map((row) => {
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

      trace.counters.objectsReturned = rows.length;

      return rows;
    },
  };
}
