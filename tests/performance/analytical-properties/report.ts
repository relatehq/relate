import type { Span } from './timing.js';
import type { Scenario } from './scenarios.js';

export interface Sample {
  scenario: Scenario;
  mode: 'hybrid-mock' | 'sqlite-reference';
  phase: 'first-of-scenario' | 'warmup' | 'warm';
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

export interface WorkloadReport {
  config: { customers: number; events: number };
  samples: Sample[];
  error?: string;
}

export function markdown(workloads: WorkloadReport[]): string {
  return [
    '# Analytical benchmark harness',
    '',
    'Hybrid results include mocked analytics and synthetic source access. They are not Relate analytical performance measurements and must not be compared with the SQLite reference as overhead.',
    '',
    'SQLite reference uses real in-process SQL against an in-memory database. First-of-scenario means the first iteration of that mode/scenario on shared, potentially warmed resources, not a fresh runtime or cold database. Warmups are reported separately. p95 is omitted below 20 successful samples.',
    '',
    ...workloads.flatMap((workload) => [
      `## Workload: ${workload.config.customers} customers / ${workload.config.events} events`,
      '',
      ...(workload.error === undefined
        ? []
        : [`Workload failed: ${JSON.stringify(workload.error)}`, '']),
      '| Mode/scenario/phase | Samples | Failures | Median ms | p95 ms |',
      '| --- | ---: | ---: | ---: | ---: |',
      ...summarizeSamples(workload.samples).map(
        (s) =>
          `| ${s.group} | ${s.samples} | ${s.failures} | ${s.medianMs?.toFixed(3) ?? 'n/a'} | ${s.p95Ms?.toFixed(3) ?? 'n/a'} |`,
      ),
      '',
    ]),
  ].join('\n');
}
