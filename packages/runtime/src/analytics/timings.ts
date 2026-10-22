import { analyticalTimingStages as stages } from '@relate/protocol';
import type {
  AnalyticalTimingStage,
  AnalyticalTimings,
  StageTiming,
} from '@relate/protocol';

export type {
  AnalyticalTimingStage,
  AnalyticalTimings,
  StageTiming,
} from '@relate/protocol';

export interface TimingCapture {
  begin(stage: AnalyticalTimingStage): () => void;
  record(stage: AnalyticalTimingStage, durationMs: number): void;
}

/** Constant-size aggregation. A bad clock or diagnostic observer cannot fail a read. */
export function createAnalyticalTimings(
  now: () => number = () => performance.now(),
) {
  const values = new Map<AnalyticalTimingStage, StageTiming>();
  const record = (stage: AnalyticalTimingStage, durationMs: number) => {
    if (
      !stages.includes(stage) ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    )
      return;

    const previous = values.get(stage);

    values.set(stage, {
      count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1),
      totalMs: Math.min(
        Number.MAX_VALUE,
        (previous?.totalMs ?? 0) + durationMs,
      ),
      maxMs: Math.max(previous?.maxMs ?? 0, durationMs),
    });
  };

  return Object.freeze({
    record,
    begin(stage: AnalyticalTimingStage) {
      let started: number;

      try {
        started = now();
      } catch {
        return () => {};
      }

      let closed = false;

      return () => {
        if (closed) return;

        closed = true;

        try {
          const elapsed = now() - started;

          if (Number.isFinite(started)) record(stage, elapsed);
        } catch {
          /* Best effort diagnostics. */
        }
      };
    },
    snapshot(): AnalyticalTimings {
      return Object.freeze({
        stages: Object.freeze(
          Object.fromEntries(
            [...values].map(([stage, timing]) => [
              stage,
              Object.freeze({ ...timing }),
            ]),
          ),
        ),
      });
    },
  });
}

export function beginTiming(
  capture: TimingCapture | undefined,
  stage: AnalyticalTimingStage,
): () => void {
  try {
    const end = capture?.begin(stage);

    return () => {
      try {
        void Promise.resolve(end?.()).catch(() => {});
      } catch {
        /* Diagnostics cannot change execution. */
      }
    };
  } catch {
    return () => {};
  }
}

export function recordTiming(
  capture: TimingCapture | undefined,
  stage: AnalyticalTimingStage,
  durationMs: number,
): void {
  try {
    void Promise.resolve(capture?.record(stage, durationMs)).catch(() => {});
  } catch {
    /* Diagnostics cannot change execution. */
  }
}
