import type { Span } from './timing.js';
import type { Scenario } from './scenarios.js';

export interface Sample {
  scenario: Scenario;
  mode: 'hybrid-mock' | 'sqlite-reference';
  phase: 'first-request' | 'warm';
  durationMs: number;
  spans: Span[];
  counters: Record<string, number>;
  status: 'ok' | 'error';
  error?: string;
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function summarizeSamples(samples: Sample[]) {
  return [
    ...new Set(samples.map((s) => `${s.mode}/${s.scenario}/${s.phase}`)),
  ].map((group) => {
    const selected = samples.filter(
      (s) => `${s.mode}/${s.scenario}/${s.phase}` === group,
    );
    const durations = selected
      .filter((s) => s.status === 'ok')
      .map((s) => s.durationMs);

    return {
      group,
      samples: selected.length,
      failures: selected.length - durations.length,
      medianMs: percentile(durations, 0.5),
      p95Ms: durations.length >= 20 ? percentile(durations, 0.95) : null,
    };
  });
}

export function markdown(samples: Sample[]): string {
  const rows = summarizeSamples(samples).map(
    (s) =>
      `| ${s.group} | ${s.samples} | ${s.failures} | ${s.medianMs?.toFixed(3) ?? 'n/a'} | ${s.p95Ms?.toFixed(3) ?? 'n/a'} |`,
  );

  return [
    '# Analytical benchmark harness',
    '',
    'Hybrid results include mocked analytics and synthetic source access. They are not Relate analytical performance measurements and must not be compared with the SQLite reference as overhead.',
    '',
    'SQLite reference uses real in-process SQL against an in-memory database. First-request means the first query after setup; it is not a cold database/cache measurement. p95 is omitted below 20 successful samples.',
    '',
    '| Mode/scenario/phase | Samples | Failures | Median ms | p95 ms |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
  ].join('\n');
}
