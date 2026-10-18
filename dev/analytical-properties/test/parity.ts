import { describe, expect, it, vi } from 'vitest';
import { createAnalyticalSpike } from '../runtime.js';
import { parseExpression } from '../parser.js';
import { fixture, customers, expressions } from './support.js';
import { accepted } from './corpus.js';

export function parity(dialect: 'sqlite' | 'postgres') {
  describe(`${dialect}: real SQL execution`, () => {
    it.each(accepted)('$name', async ({ sql, values }) => {
      const { backend, association } = await fixture(dialect);

      association.columns.userId!.readable = true;
      const read = createAnalyticalSpike(backend, association, parseExpression);
      const result = await read(customers(), { compute: { value: { sql } } });

      expect(result.data.map((row) => row.data.value)).toEqual(values);
    });
    it('batches aliases in one statement; empty groups and timestamps have identical JSON', async () => {
      const { backend, association } = await fixture(dialect);
      const execute = vi.spyOn(backend, 'execute');
      const result = await createAnalyticalSpike(
        backend,
        association,
        parseExpression,
      )(customers(), { compute: expressions() });

      expect(result.data.map((r) => r.data)).toEqual([
        { loginsOct: '2', lastLogin: '2026-10-09T10:30:00.000Z' },
        { loginsOct: '1', lastLogin: '2026-10-03T14:00:00.000Z' },
        { loginsOct: '0', lastLogin: null },
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.computed).toEqual({
        loginsOct: { type: 'int64', nullable: false },
        lastLogin: { type: 'timestamp', nullable: true },
      });
    });
    it('preserves per-object self values when correlation keys repeat', async () => {
      const { backend, association } = await fixture(dialect);
      const candidates = customers();

      candidates.push({
        id: 'acme-later',
        properties: {
          externalId: 'crm_acme',
          customerSince: '2026-10-08T00:00:00.000Z',
        },
      });
      const result = await createAnalyticalSpike(
        backend,
        association,
        parseExpression,
      )(candidates, {
        compute: {
          count: { sql: accepted.find((c) => c.name === 'self-property')!.sql },
        },
      });

      expect(result.data.map((r) => r.data.count)).toEqual([
        '2',
        '1',
        '0',
        '1',
      ]);
    });
    it('a missing self dependency does not suppress unrelated aliases', async () => {
      const { backend, association } = await fixture(dialect);
      const candidates = customers();

      delete candidates[0]!.properties.customerSince;
      const result = await createAnalyticalSpike(
        backend,
        association,
        parseExpression,
      )(candidates, {
        compute: {
          count: { sql: 'SELECT COUNT(*) FROM self.events' },
          since: {
            sql: 'SELECT COUNT(*) FROM self.events e WHERE e.occurredAt >= self.customerSince',
          },
        },
      });

      expect(result.data[0]!.data).toEqual({ count: '4' });
      expect(result.data[0]!.fields.since).toEqual({
        status: 'unavailable',
        reason: 'correlation-unavailable',
      });
      expect(result.data[1]!.data).toEqual({ count: '1', since: '1' });
    });
    it('keeps values invariant across key batch sizes and object page sizes', async () => {
      const { backend, association } = await fixture(dialect);
      const read = createAnalyticalSpike(
        backend,
        association,
        parseExpression,
        { batchSize: 1 },
      );
      const whole = await read(customers(), { compute: expressions() });
      const first = await read(customers(), {
        compute: expressions(),
        limit: 1,
      });

      expect(first.data[0]!.data).toEqual(whole.data[0]!.data);
    });
    it('filters the full scope before paging; nulls last and ID ties are stable in both directions', async () => {
      const { backend, association } = await fixture(dialect);
      const candidates = customers();

      candidates.push({ ...candidates[0]!, id: 'acme-2' });
      const read = createAnalyticalSpike(
        backend,
        association,
        parseExpression,
        { batchSize: 2 },
      );

      for (const direction of ['asc', 'desc'] as const) {
        const request = {
          compute: expressions(),
          orderBy: [{ field: 'lastLogin', direction }],
          limit: 1,
        };
        const ids: string[] = [];
        let after;

        do {
          const page = await read(candidates, {
            ...request,
            ...(after ? { after } : {}),
          });

          ids.push(...page.data.map((r) => r.id));
          after = page.after;
        } while (after);

        expect(ids).toEqual(
          direction === 'desc'
            ? ['acme', 'acme-2', 'globex', 'initech']
            : ['globex', 'acme', 'acme-2', 'initech'],
        );
      }

      const result = await read(candidates, {
        compute: expressions(),
        where: { loginsOct: { eq: '0' } },
        limit: 1,
      });

      expect(result.data.map((r) => r.id)).toEqual(['initech']);
    });
    it('treats parameters as values and quotes host-owned physical names', async () => {
      const { backend, association } = await fixture(dialect);
      const execute = vi.spyOn(backend, 'execute');
      const sql =
        'SELECT COUNT(*) FROM self.events e WHERE e.eventType = $kind';
      const injection = "login' OR 1=1 --";
      const result = await createAnalyticalSpike(
        backend,
        association,
        parseExpression,
      )(customers(), {
        compute: { count: { sql, parameters: { kind: injection } } },
      });

      expect(result.data.map((r) => r.data.count)).toEqual(['0', '0', '0']);
      expect(execute.mock.calls[0]![0].text).not.toContain(injection);
      expect(execute.mock.calls[0]![0].values).toContain(injection);
    });
    it('uses composite correlation without cross-customer widening', async () => {
      const { backend, association } = await fixture(dialect);

      association.properties.kind = { type: 'string', readable: true };
      association.on.eventType = 'kind';
      const candidates = customers().map((c) => ({
        ...c,
        properties: { ...c.properties, kind: 'page_view' },
      }));
      const result = await createAnalyticalSpike(
        backend,
        association,
        parseExpression,
      )(candidates, {
        compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
      });

      expect(result.data.map((r) => r.data.count)).toEqual(['1', '0', '0']);
    });
    it('cancels a long statement with a host timeout and can execute afterward', async () => {
      const { backend } = await fixture(dialect);
      const text =
        dialect === 'postgres'
          ? 'SELECT pg_sleep(5)'
          : 'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT SUM(x) FROM n';
      const start = performance.now();

      await expect(
        backend.execute(
          { text, values: [] },
          { signal: new AbortController().signal, timeoutMs: 30 },
        ),
      ).rejects.toBeDefined();
      expect(performance.now() - start).toBeLessThan(3000);
      const rows = await backend.execute(
        { text: 'SELECT 1 AS value', values: [] },
        { signal: new AbortController().signal, timeoutMs: 1000 },
      );

      expect(String(rows[0]!.value)).toBe('1');
    });
    it('preserves caller abort instead of returning partial values', async () => {
      const { backend } = await fixture(dialect);
      const controller = new AbortController();
      const reason = new Error('caller-timeout');
      const text =
        dialect === 'postgres'
          ? 'SELECT pg_sleep(5)'
          : 'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT SUM(x) FROM n';
      const pending = backend.execute(
        { text, values: [] },
        { signal: controller.signal, timeoutMs: 5000 },
      );
      const timer = setTimeout(() => controller.abort(reason), 100);

      try {
        await expect(pending).rejects.toBe(reason);
      } finally {
        clearTimeout(timer);
      }
    });
    it('opens analytical execution read-only', async () => {
      const { backend, association } = await fixture(dialect);

      await expect(
        backend.execute(
          { text: `DELETE FROM "${association.table}"`, values: [] },
          { signal: new AbortController().signal, timeoutMs: 1000 },
        ),
      ).rejects.toBeDefined();
    });
  });
}
