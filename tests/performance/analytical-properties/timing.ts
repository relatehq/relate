import type {
  AnalyticalTimings,
  AnalyticalTimingStage,
} from '@relate/protocol';

export interface Span {
  name: string;
  kind: 'real';
  startMs: number;
  durationMs: number;
}

export class Trace {
  private origin = performance.now();
  readonly spans: Span[] = [];
  readonly counters: Record<string, number> = {};
  readonly stages: AnalyticalTimings['stages'] = {};
  /** Diagnostic delivery is outside request latency; completed before the next request. */
  settle: () => Promise<void> = async () => {};
  addTimings(timings: AnalyticalTimings) {
    for (const [name, value] of Object.entries(timings.stages)) {
      const stage = name as AnalyticalTimingStage;
      const previous = this.stages[stage];

      Object.assign(this.stages, {
        [stage]: {
          count: (previous?.count ?? 0) + value.count,
          totalMs: (previous?.totalMs ?? 0) + value.totalMs,
          maxMs: Math.max(previous?.maxMs ?? 0, value.maxMs),
        },
      });
    }
  }
  async measure<T>(
    name: string,
    kind: Span['kind'],
    task: () => T | Promise<T>,
  ): Promise<T> {
    const start = performance.now();

    try {
      return await task();
    } finally {
      this.spans.push({
        name,
        kind,
        startMs: start - this.origin,
        durationMs: performance.now() - start,
      });
    }
  }
}
