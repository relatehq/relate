import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  events,
  summarize,
} from '../performance/analytical-properties/seed.js';
import {
  runWorkload,
  measureScenario,
  runProfile,
  gitMetadata,
} from '../performance/analytical-properties/run.js';
import {
  markdown,
  instrumentationComparison,
  percentile,
  summarizeSamples,
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
      (s) => s.mode === 'relate' && s.scenario === 'ranking',
    )!;

    expect(ranking.counters.candidatesAdmitted).toBe(112);
    expect(ranking.counters.objectsReturned).toBe(25);
    expect(ranking.counters.analyticalStatements).toBe(2);
    expect(ranking.counters.analyticalBatches).toBe(2);
    expect(ranking.counters.computedSlots).toBe(112);
    expect(ranking.counters.candidatesScanned).toBe(140);
    expect(ranking.counters.sourceFetches).toBe(0);
    expect(ranking.counters.capturedOperations).toBe(2);
    expect(ranking.stages.execution?.count).toBe(2);
    expect(ranking.stages.preparation?.count).toBe(2);
    expect(ranking.spans.map((s) => s.name)).toContain('benchmark-local-sort');
    expect(result.summary.every((s) => s.p95Ms === null)).toBe(true);
    expect(markdown([result])).toContain('must not be compared');
  });

  it('keeps nested spans as intervals and records failed operations', async () => {
    const trace = new Trace();

    await expect(
      trace.measure('outer', 'real', () =>
        trace.measure('inner', 'real', () => {
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
  it('keeps failed warmups separate from the 30 measured repetitions', async () => {
    const samples = await measureScenario(
      'objects',
      { warmups: 3, repetitions: 30 },
      () => [],
      async () => {
        throw new Error('Relate failed');
      },
    );
    const relate = samples.filter((s) => s.mode === 'relate');

    expect(relate.filter((s) => s.phase === 'warm')).toHaveLength(30);
    expect(relate.filter((s) => s.phase === 'warmup')).toHaveLength(3);
    expect(relate.filter((s) => s.phase === 'first-of-scenario')).toHaveLength(
      1,
    );
    expect(relate.every((s) => s.status === 'error')).toBe(true);
    expect(summarizeSamples(samples)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: 'relate/objects/warm',
          samples: 30,
          failures: 30,
        }),
        expect.objectContaining({
          group: 'relate/objects/warmup',
          samples: 3,
          failures: 3,
        }),
      ]),
    );
  });

  it('never accepts a Relate result when the SQLite oracle is unavailable', async () => {
    const relate = vi.fn(async () => []);
    const samples = await measureScenario(
      'objects',
      { warmups: 1, repetitions: 2 },
      () => {
        throw new Error('SQL failed');
      },
      relate,
    );

    expect(relate).not.toHaveBeenCalled();
    expect(samples.every((s) => s.status === 'error')).toBe(true);
    expect(
      samples
        .filter((s) => s.mode === 'relate')
        .every((s) => s.error?.includes('oracle unavailable')),
    ).toBe(true);
  });

  it('detects Relate mismatches against the SQLite oracle', async () => {
    const samples = await measureScenario(
      'objects',
      { warmups: 0, repetitions: 1 },
      () => [{ id: 'a', data: { name: 'expected' } }],
      async () => [{ id: 'a', data: { name: 'wrong' } }],
    );

    expect(
      samples
        .filter((s) => s.mode === 'relate')
        .every((s) => s.status === 'error'),
    ).toBe(true);
  });

  it('measures real refreshes and suppresses timing capture when disabled', async () => {
    const result = await runWorkload({
      customers: 12,
      events: 20,
      seed: 42,
      warmups: 0,
      repetitions: 1,
      capture: 'disabled',
      freshness: 'refresh',
    });

    expect(
      result.samples.filter((sample) => sample.status === 'error'),
    ).toEqual([]);
    const ranking = result.samples.find(
      (sample) =>
        sample.mode === 'relate' &&
        sample.scenario === 'ranking' &&
        sample.phase === 'warm',
    )!;

    expect(ranking.counters.candidatesScanned).toBe(12);
    expect(ranking.counters.sourceFetches).toBe(12);
    expect(ranking.counters.capturedOperations).toBe(0);
    expect(ranking.stages).toEqual({});
    expect(ranking.counters.analyticalStatements).toBe(1);
  });

  it('checkpoints completed workloads and records a later setup failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analytical-report-'));

    try {
      const config = {
        customers: 10,
        events: 20,
        seed: 42,
        warmups: 0,
        repetitions: 1,
      };
      let calls = 0;
      const result = await runProfile(
        [config, config, config],
        directory,
        {},
        async (input) => {
          calls++;

          if (calls === 2) {
            const checkpoint = JSON.parse(
              await readFile(join(directory, 'results.json'), 'utf8'),
            );

            expect(checkpoint.workloads).toHaveLength(1);
            throw new Error('setup failed');
          }

          if (calls === 3) {
            const checkpoint = JSON.parse(
              await readFile(join(directory, 'results.json'), 'utf8'),
            );

            expect(checkpoint.workloads[1].error).toBe('setup failed');
          }

          return runWorkload(input);
        },
      );

      expect(result.failed).toBe(true);
      expect(result.workloads).toHaveLength(3);
      const saved = JSON.parse(
        await readFile(join(directory, 'results.json'), 'utf8'),
      );

      expect(saved.workloads[0].samples).toHaveLength(12);
      expect(saved.workloads[1].error).toBe('setup failed');
      expect(saved.workloads[2].samples).toHaveLength(12);
      const report = await readFile(join(directory, 'report.md'), 'utf8');

      expect(report.match(/^# Analytical benchmark harness$/gm)).toHaveLength(
        1,
      );
      expect(report.match(/^## Workload:/gm)).toHaveLength(3);
      expect(report).toContain('setup failed');
      expect(gitMetadata(directory)).toEqual({ commit: null, dirty: null });
      expect(
        gitMetadata(directory, 'missing-benchmark-git-executable'),
      ).toEqual({ commit: null, dirty: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('compares only matching capture configurations and retains noisy negative differences', () => {
  const sample = (durationMs: number) => ({
    scenario: 'enrichment' as const,
    mode: 'relate' as const,
    phase: 'warm' as const,
    durationMs,
    spans: [],
    counters: {},
    stages: {},
    status: 'ok' as const,
  });
  const result = instrumentationComparison([
    {
      config: {
        customers: 100,
        events: 1000,
        backend: 'sqlite',
        capture: 'disabled',
      },
      samples: [sample(20)],
    },
    {
      config: {
        capture: 'enabled',
        backend: 'sqlite',
        events: 1000,
        customers: 100,
      },
      samples: [sample(18)],
    },
    {
      config: {
        customers: 100,
        events: 1000,
        backend: 'postgres',
        capture: 'enabled',
      },
      samples: [sample(1)],
    },
  ]);

  expect(result.filter((row) => row.scenario === 'enrichment')).toEqual([
    expect.objectContaining({
      disabledMedianMs: 20,
      enabledMedianMs: 18,
      differenceMs: -2,
      ratio: 0.9,
    }),
  ]);
});

it('drains diagnostics after failures and records delivery failure without hiding the measured request', async () => {
  let drained = 0;
  const samples = await measureScenario(
    'objects',
    { warmups: 0, repetitions: 1 },
    () => [],
    async (trace) => {
      trace.settle = async () => {
        drained++;
        throw new Error('delivery failed');
      };

      return [];
    },
  );

  expect(drained).toBe(2);
  expect(samples.filter((sample) => sample.mode === 'relate')).toEqual([
    expect.objectContaining({
      status: 'error',
      error: 'delivery failed',
      durationMs: expect.any(Number),
    }),
    expect.objectContaining({
      status: 'error',
      error: 'delivery failed',
      durationMs: expect.any(Number),
    }),
  ]);
});

it('reports no analytical execution for an entirely unauthorized population', async () => {
  const result = await runWorkload({
    customers: 1,
    events: 1,
    seed: 42,
    warmups: 0,
    repetitions: 1,
  });

  expect(result.samples.filter((sample) => sample.status === 'error')).toEqual(
    [],
  );
  const ranking = result.samples.find(
    (sample) =>
      sample.mode === 'relate' &&
      sample.scenario === 'ranking' &&
      sample.phase === 'warm',
  )!;

  expect(ranking.counters).toMatchObject({
    candidatesScanned: 1,
    candidatesAdmitted: 0,
    objectsReturned: 0,
    analyticalBatches: 0,
    analyticalStatements: 0,
    computedSlots: 0,
  });
  expect(ranking.stages).not.toHaveProperty('execution');
});
