import { expect, it } from 'vitest';
import { runOverhead } from '../performance/analytical-properties/overhead/run.js';

for (const backend of ['postgres', 'duckdb'] as const)
  it(`${backend}: exact-plan replay and colocated alternatives preserve multi-batch results`, async () => {
    const result = await runOverhead({
      backend,
      customers: 1255,
      events: 200,
      repetitions: 1,
      warmups: 0,
      objectStore: 'memory',
      freshness: 'cached',
      sourceDelayMs: 0,
    });

    expect(result.samples).toHaveLength(24);
    expect(result.samples.filter((s) => s.status === 'error')).toEqual([]);
    const ranking = result.samples.filter(
      (s) => s.mode === 'relate' && s.scenario === 'ranking',
    );

    expect(ranking).toHaveLength(2);

    for (const s of ranking) {
      expect(s.counters).toMatchObject({
        candidatesAdmitted: 1004,
        analyticalStatements: 2,
        objectsReturned: 25,
      });
      expect(s.intervals).toHaveLength(2);
      expect(s.connectorBusyMs).toBeGreaterThan(0);
      expect(s.outsideConnectorMs).toBeGreaterThan(0);
      expect(s.connectorBusyMs! + s.outsideConnectorMs!).toBeCloseTo(
        s.durationMs,
        6,
      );
    }
  }, 60000);
