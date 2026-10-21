import { expect, it } from 'vitest';
import {
  createAnalyticalTimings,
  createStatementQueue,
} from '../src/analytics/index.js';
import { beginTiming, recordTiming } from '../src/analytics/timings.js';

it('aggregates fixed stages with overlapping spans and detached frozen snapshots', () => {
  let now = 0;
  const capture = createAnalyticalTimings(() => now);
  const outer = capture.begin('candidates');

  now = 3;
  const first = capture.begin('dependencyReads');

  now = 5;
  const second = capture.begin('dependencyReads');

  now = 9;
  first();
  now = 12;
  second();
  outer();
  first();
  second();
  const snapshot = capture.snapshot();

  expect(snapshot.stages).toEqual({
    candidates: { count: 1, totalMs: 12, maxMs: 12 },
    dependencyReads: { count: 2, totalMs: 13, maxMs: 7 },
  });
  expect(snapshot.stages).not.toHaveProperty('execution');
  expect(Object.isFrozen(snapshot.stages.dependencyReads)).toBe(true);
  capture.record('execution', 4);
  expect(snapshot.stages).not.toHaveProperty('execution');
  expect(capture.snapshot().stages.execution).toEqual({
    count: 1,
    totalMs: 4,
    maxMs: 4,
  });
});

it('ignores invalid clocks, invalid measurements and diagnostic failures', async () => {
  const capture = createAnalyticalTimings(() => {
    throw new Error('clock');
  });

  expect(() => capture.begin('planning')()).not.toThrow();

  for (const duration of [-1, NaN, Infinity])
    capture.record('execution', duration);

  capture.record('caller-sql' as never, 1);
  expect(capture.snapshot()).toEqual({ stages: {} });
  const broken = {
    begin() {
      throw new Error('observer');
    },
    async record() {
      throw new Error('observer');
    },
  };

  expect(() => beginTiming(broken, 'planning')()).not.toThrow();
  recordTiming(broken, 'execution', 1);
  const end = beginTiming(
    {
      begin: () => async () => {
        throw new Error('end');
      },
      record() {},
    },
    'planning',
  );

  end();
  await Promise.resolve();
});

it('measures queue admission and cancellation without inventing execution spans', async () => {
  const queue = createStatementQueue({ concurrency: 1 });
  const capture = createAnalyticalTimings();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(() => gate, {
    signal: new AbortController().signal,
    onWait: (duration) => capture.record('queueWait', duration),
  });
  const controller = new AbortController();
  const second = queue.run(
    async () => {
      throw new Error('Should not be admitted');
    },
    {
      signal: controller.signal,
      onWait: (duration) => capture.record('queueWait', duration),
    },
  );

  controller.abort('cancelled');
  await expect(second).rejects.toBe('cancelled');
  expect(capture.snapshot().stages.queueWait!.count).toBe(2);
  expect(capture.snapshot().stages).not.toHaveProperty('execution');
  release();
  await first;
  await queue.retire();
});

it('ignores queue timing observers that throw or reject', async () => {
  const queue = createStatementQueue();

  expect(
    await queue.run(async () => 1, {
      signal: new AbortController().signal,
      onWait() {
        throw new Error('observer');
      },
    }),
  ).toBe(1);
  expect(
    await queue.run(async () => 2, {
      signal: new AbortController().signal,
      async onWait() {
        throw new Error('observer');
      },
    }),
  ).toBe(2);
  await queue.retire();
});
