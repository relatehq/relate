import { describe, expect, it } from 'vitest';
import {
  events,
  summarize,
} from '../performance/analytical-properties/seed.js';
import { runWorkload } from '../performance/analytical-properties/run.js';
import {
  markdown,
  percentile,
} from '../performance/analytical-properties/report.js';
import { Trace } from '../performance/analytical-properties/timing.js';

describe('analytical performance harness', () => {
  it('uses reproducible skewed events and excludes non-logins and the upper time boundary', () => {
    expect([...events(100, 100, 42)]).toEqual([...events(100, 100, 42)]);
    expect([...events(100, 100, 43)]).not.toEqual([...events(100, 100, 42)]);
    const result = summarize([
      { customer: 'a', type: 'login', at: '2026-10-01T00:00:00.000Z' },
      { customer: 'a', type: 'login', at: '2026-10-31T00:00:00.000Z' },
      { customer: 'a', type: 'login', at: '2026-11-01T00:00:00.000Z' },
      { customer: 'a', type: 'view', at: '2026-10-31T12:00:00.000Z' },
    ]);

    expect(result.get('a')).toEqual({
      loginCount: '2',
      lastLogin: '2026-10-31T00:00:00.000Z',
    });
  });

  it('checks all scenarios against independent SQL, including zero events and multi-page authorized scope', async () => {
    const result = await runWorkload({
      customers: 140,
      events: 20,
      seed: 42,
      repetitions: 1,
      warmups: 0,
    });

    expect(result.samples).toHaveLength(12);
    expect(result.samples.filter((s) => s.status === 'error')).toEqual([]);
    const ranking = result.samples.find(
      (s) => s.mode === 'hybrid-mock' && s.scenario === 'ranking',
    )!;

    expect(ranking.counters.candidatesAdmitted).toBe(112);
    expect(ranking.counters.objectsReturned).toBe(25);
    expect(ranking.counters.analyticalStatements).toBe(0);
    expect(
      ranking.spans.filter((s) => s.kind === 'mock').map((s) => s.name),
    ).toEqual([
      'analytical-preparation',
      'analytical-execution',
      'computed-finalization',
    ]);
    expect(result.summary.every((s) => s.p95Ms === null)).toBe(true);
    expect(markdown(result.samples)).toContain('must not be compared');
  });

  it('keeps nested spans as intervals and records failed operations', async () => {
    const trace = new Trace();

    await expect(
      trace.measure('outer', 'real', () =>
        trace.measure('inner', 'mock', () => {
          throw new Error('failed');
        }),
      ),
    ).rejects.toThrow('failed');
    expect(trace.spans.map((s) => s.name)).toEqual(['inner', 'outer']);
    const [inner, outer] = trace.spans;

    expect(outer!.startMs).toBeLessThanOrEqual(inner!.startMs);
    expect(outer!.durationMs).toBeGreaterThanOrEqual(inner!.durationMs);
    expect(percentile([], 0.95)).toBeNull();
    expect(
      percentile(
        Array.from({ length: 100 }, (_, i) => i + 1),
        0.95,
      ),
    ).toBe(95);
  });
});
