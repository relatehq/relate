import type { AnalyticalTimings } from '@relate/protocol';
import type { Span } from './timing.js';
import type { Scenario } from './scenarios.js';

export interface Sample {
  scenario: Scenario;
  mode: 'relate' | 'sqlite-reference';
  phase: 'first-of-scenario' | 'warmup' | 'warm';
  durationMs: number;
  spans: Span[];
  counters: Record<string, number>;
  stages: AnalyticalTimings['stages'];
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
  config: {
    customers: number;
    events: number;
    backend?: string;
    objectStore?: string;
    capture?: string;
    freshness?: string;
    seed?: number;
    sourceDelayMs?: number;
  };
  samples: Sample[];
  error?: string;
}

export function instrumentationComparison(workloads: WorkloadReport[]) {
  return workloads
    .filter(
      (workload) => workload.config.capture === 'enabled' && !workload.error,
    )
    .flatMap((enabled) => {
      const { capture: _capture, ...config } = enabled.config;
      const disabled = workloads.find((workload) => {
        const { capture, ...other } = workload.config;

        return (
          capture === 'disabled' &&
          !workload.error &&
          JSON.stringify(
            Object.entries(other).sort(([a], [b]) => a.localeCompare(b)),
          ) ===
            JSON.stringify(
              Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
            )
        );
      });

      if (!disabled) return [];

      return (['objects', 'enrichment', 'ranking'] as const).map((scenario) => {
        const median = (workload: WorkloadReport) => {
          const samples = workload.samples.filter(
            (s) =>
              s.mode === 'relate' &&
              s.scenario === scenario &&
              s.phase === 'warm',
          );

          return samples.some((s) => s.status === 'error')
            ? null
            : percentile(
                samples.map((s) => s.durationMs),
                0.5,
              );
        };
        const on = median(enabled),
          off = median(disabled);

        return {
          config,
          scenario,
          enabledMedianMs: on,
          disabledMedianMs: off,
          differenceMs: on !== null && off !== null ? on - off : null,
          ratio: on !== null && off !== null && off > 0 ? on / off : null,
        };
      });
    });
}

export function markdown(workloads: WorkloadReport[]): string {
  return [
    '# Analytical benchmark harness',
    '',
    'Relate samples execute real public query pages, analytical statements and revalidation. Ranking enumerates every authorized page and sorts locally in the benchmark; it does not measure runtime computed order or a single full-scope operation.',
    '',
    'SQLite reference is independent handwritten in-memory SQL. Its latency must not be compared as equivalent work: it excludes graph authorization, evidence and connector lifecycle. First-of-scenario uses shared, potentially warmed resources; it is not a cold start. Warmups are separate. p95 is omitted below 20 successful samples.',
    '',
    'Activity stages are summed work durations, with nesting and overlap; they are not additive parts of request elapsed time. Diagnostic delivery drains outside elapsed time. Object sources are synthetic; configured refresh delay is measured, not a production provider estimate.',
    '',
    ...workloads.flatMap((workload) => {
      const warmed = workload.samples.filter(
        (sample) =>
          sample.mode === 'relate' &&
          sample.phase === 'warm' &&
          sample.status === 'ok',
      );
      const scenarios = [...new Set(warmed.map((sample) => sample.scenario))];

      return [
        `## Workload: ${workload.config.customers} customers / ${workload.config.events} events`,
        '',
        `Backend: ${workload.config.backend}; object store: ${workload.config.objectStore}; capture: ${workload.config.capture}; freshness: ${workload.config.freshness}; synthetic refresh delay: ${workload.config.sourceDelayMs ?? 0} ms.`,
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
        '| Scenario | Counter | Median |',
        '| --- | --- | ---: |',
        ...scenarios.flatMap((scenario) => {
          const samples = warmed.filter(
            (sample) => sample.scenario === scenario,
          );

          return [
            ...new Set(
              samples.flatMap((sample) => Object.keys(sample.counters)),
            ),
          ].map(
            (key) =>
              `| ${scenario} | ${key} | ${percentile(
                samples.map((sample) => sample.counters[key] ?? 0),
                0.5,
              )} |`,
          );
        }),
        '',
        '| Scenario | Stage | Median summed ms | Median spans | Longest observed ms |',
        '| --- | --- | ---: | ---: | ---: |',
        ...scenarios.flatMap((scenario) => {
          const samples = warmed.filter(
            (sample) => sample.scenario === scenario,
          );

          return [
            ...new Set(samples.flatMap((sample) => Object.keys(sample.stages))),
          ].map((key) => {
            const values = samples.flatMap((sample) => {
              const stage = sample.stages[key as keyof typeof sample.stages];

              return stage ? [stage] : [];
            });

            return `| ${scenario} | ${key} | ${percentile(
              values.map((stage) => stage.totalMs),
              0.5,
            )?.toFixed(3)} | ${percentile(
              values.map((stage) => stage.count),
              0.5,
            )} | ${Math.max(...values.map((stage) => stage.maxMs)).toFixed(3)} |`;
          });
        }),
        '',
      ];
    }),
    '## Activity instrumentation comparison',
    '',
    'Paired configurations use the same seeded data and request semantics. These sequential median differences include capture and timing overhead plus run-to-run noise; negative differences are retained. They exclude waiting for asynchronous activity delivery and are not causal estimates of timing calls alone.',
    '',
    '| Backend/store/freshness | Customers/events | Scenario | Disabled ms | Enabled ms | Difference ms | Ratio |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    ...instrumentationComparison(workloads).map(
      (row) =>
        `| ${row.config.backend}/${row.config.objectStore}/${row.config.freshness} | ${row.config.customers}/${row.config.events} | ${row.scenario} | ${row.disabledMedianMs?.toFixed(3) ?? 'n/a'} | ${row.enabledMedianMs?.toFixed(3) ?? 'n/a'} | ${row.differenceMs?.toFixed(3) ?? 'n/a'} | ${row.ratio?.toFixed(3) ?? 'n/a'} |`,
    ),
    '',
  ].join('\n');
}
