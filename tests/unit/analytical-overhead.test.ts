import { expect, it } from 'vitest';
import pg from 'pg';
import { ChildProcess } from 'node:child_process';
import type { AnalyticalResource } from 'relate/connectors';
import {
  concurrentMap,
  observeResource,
  unionDuration,
} from '../performance/analytical-properties/overhead/capture.js';
import {
  differences,
  modeOrder,
  modes,
} from '../performance/analytical-properties/overhead/run.js';
import type { Sample } from '../performance/analytical-properties/overhead/run.js';

it('unions overlapping and nested connector intervals instead of summing them', () => {
  expect(
    unionDuration([
      { startMs: 5, endMs: 12 },
      { startMs: 0, endMs: 8 },
      { startMs: 2, endMs: 3 },
      { startMs: 15, endMs: 17 },
    ]),
  ).toBe(14);
  expect(unionDuration([])).toBe(0);
  expect(() => unionDuration([{ startMs: 4, endMs: 2 }])).toThrow();
});

it('balances each mode across execution positions over a complete order cycle', () => {
  for (let slot = 0; slot < modes.length; slot++) {
    const orders = Array.from(
      { length: 12 },
      (_, block) => modeOrder(block)[slot],
    );

    for (const mode of modes)
      expect(orders.filter((v) => v === mode)).toHaveLength(2);
  }
});

it('compares matched blocks, retains negative differences and excludes failed pairs', () => {
  const sample = (
    mode: Sample['mode'],
    block: number,
    durationMs: number,
    status: Sample['status'] = 'ok',
  ): Sample => ({
    mode,
    block,
    durationMs,
    status,
    scenario: 'ranking',
    phase: 'warm',
    order: 0,
  });
  const result = differences([
    sample('relate', 1, 30),
    sample('connector', 2, 100),
    sample('connector', 1, 40),
    sample('relate', 2, 50, 'error'),
  ]);

  expect(
    result.find(
      (r) =>
        r.scenario === 'ranking' && r.comparison === 'relate minus connector',
    ),
  ).toMatchObject({ pairs: 1, excluded: 1, medianDifferenceMs: -10 });
});

it('drains in-flight workers after failure without exceeding concurrency', async () => {
  let active = 0,
    peak = 0,
    completed = 0;

  await expect(
    concurrentMap([0, 1, 2, 3], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);

      try {
        await new Promise((resolve) => setTimeout(resolve, 5));

        if (value === 0) throw new Error('injected');

        completed++;

        return value;
      } finally {
        active--;
      }
    }),
  ).rejects.toThrow('injected');
  expect(active).toBe(0);
  expect(peak).toBe(2);
  expect(completed).toBe(3);
});

it('restores driver and IPC methods when untimed capture fails', async () => {
  const query = pg.Client.prototype.query,
    send = ChildProcess.prototype.send;
  const observer = observeResource({
    connection: { analytics: {} },
  } as AnalyticalResource);

  await expect(
    observer.capture(async () => {
      throw new Error('capture failed');
    }),
  ).rejects.toThrow('capture failed');
  expect(pg.Client.prototype.query).toBe(query);
  expect(ChildProcess.prototype.send).toBe(send);
  await expect(observer.capture(async () => [])).rejects.toThrow(
    'No generated statements',
  );
  expect(pg.Client.prototype.query).toBe(query);
  expect(ChildProcess.prototype.send).toBe(send);
});
