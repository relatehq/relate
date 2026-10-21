import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createProcessRunner } from '../src/analytics/process.js';
import type { AnalyticalExecutionTiming } from 'relate/connectors';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function setup() {
  const child = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    kill: vi.fn(() => true),
  });

  vi.mocked(fork).mockReturnValue(child as unknown as ChildProcess);
  let now = 0;

  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const runner = createProcessRunner({
    path: '/test.sqlite',
    busyTimeoutMs: 0,
    startupTimeoutMs: 5000,
  });
  const timings: AnalyticalExecutionTiming[] = [];
  const controller = new AbortController();
  const operation = {
    kind: 'describe' as const,
    resource: { table: 'events', columns: {} },
  };

  return {
    child,
    runner,
    timings,
    controller,
    operation,
    setTime(value: number) {
      now = value;
    },
  };
}

it('uses monotonic phase clocks and settles only after process cleanup', async () => {
  const f = setup();
  let settled = false;
  const task = f.runner
    .run(f.operation, {
      signal: f.controller.signal,
      timeoutMs: 5000,
      onTiming: (timing) => f.timings.push(timing),
    })
    .then((result) => {
      settled = true;

      return result;
    });

  f.setTime(7);
  f.child.emit('message', { kind: 'ready' });
  expect(f.timings).toEqual([{ stage: 'connectionStartup', durationMs: 7 }]);
  f.setTime(11);
  f.child.emit('message', { kind: 'result', value: { columns: {} } });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.setTime(17);
  f.child.emit('close', 0);
  expect(await task).toEqual({ columns: {} });
  expect(f.timings).toEqual([
    { stage: 'connectionStartup', durationMs: 7 },
    { stage: 'execution', durationMs: 10 },
  ]);
  await f.runner.close();
});

it.each(['abort', 'retire', 'failure'] as const)(
  'records execution cleanup exactly once after %s',
  async (reason) => {
    const f = setup();
    const task = f.runner.run(f.operation, {
      signal: f.controller.signal,
      timeoutMs: 5000,
      onTiming: (timing) => f.timings.push(timing),
    });
    const rejected = expect(task).rejects.toBeDefined();

    f.setTime(3);
    f.child.emit('message', { kind: 'ready' });
    f.setTime(8);
    let retiring: Promise<void> | undefined;

    if (reason === 'abort') f.controller.abort('stop');
    else if (reason === 'retire') retiring = f.runner.close();
    else
      f.child.emit('message', {
        kind: 'failure',
        code: 'execution-failed',
        retryable: false,
      });

    expect(f.timings).toHaveLength(1);
    f.setTime(13);
    f.child.emit('close', reason === 'failure' ? 0 : null);
    await rejected;
    await retiring;
    expect(f.timings).toEqual([
      { stage: 'connectionStartup', durationMs: 3 },
      { stage: 'execution', durationMs: 10 },
    ]);

    if (reason !== 'failure')
      expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');

    await f.runner.close();
  },
);

it('startup cancellation omits execution and waits for child exit', async () => {
  const f = setup();
  const task = f.runner.run(f.operation, {
    signal: f.controller.signal,
    timeoutMs: 5000,
    onTiming: (timing) => f.timings.push(timing),
  });
  const rejected = expect(task).rejects.toBe('stop');

  f.setTime(4);
  f.controller.abort('stop');
  f.child.emit('message', { kind: 'ready' });
  expect(f.child.send).toHaveBeenCalledTimes(1);
  expect(f.timings).toEqual([]);
  f.setTime(9);
  f.child.emit('close', null);
  await rejected;
  expect(f.timings).toEqual([{ stage: 'connectionStartup', durationMs: 9 }]);
  await f.runner.close();
});

it('does not invent execution when a startup observer cancels before dispatch', async () => {
  const f = setup();
  const task = f.runner.run(f.operation, {
    signal: f.controller.signal,
    timeoutMs: 5000,
    onTiming(timing) {
      f.timings.push(timing);
      f.controller.abort('stop');
      throw new Error('observer');
    },
  });
  const rejected = expect(task).rejects.toBe('stop');

  f.setTime(4);
  f.child.emit('message', { kind: 'ready' });
  f.setTime(6);
  f.child.emit('close', null);
  await rejected;
  expect(f.timings).toEqual([{ stage: 'connectionStartup', durationMs: 4 }]);
  expect(f.child.send).toHaveBeenCalledTimes(1);
  await f.runner.close();
});

it('reports a synchronous spawn failure safely even when diagnostics throw', async () => {
  const f = setup();

  vi.mocked(fork).mockImplementation(() => {
    f.setTime(6);
    throw new Error('private path');
  });
  await expect(
    f.runner.run(f.operation, {
      signal: f.controller.signal,
      timeoutMs: 5000,
      onTiming(timing) {
        f.timings.push(timing);
        throw new Error('observer');
      },
    }),
  ).rejects.toMatchObject({
    code: 'execution-failed',
    message: 'Analytical execution failed',
  });
  expect(f.timings).toEqual([{ stage: 'connectionStartup', durationMs: 6 }]);
  await f.runner.close();
});

it('withholds a completed result when retirement occurs before publication', async () => {
  const f = setup();
  let retirement: Promise<void> | undefined;
  const task = f.runner.run(f.operation, {
    signal: f.controller.signal,
    timeoutMs: 5000,
    onTiming(timing) {
      f.timings.push(timing);

      if (timing.stage === 'execution') retirement = f.runner.close();
    },
  });
  const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });

  f.setTime(2);
  f.child.emit('message', { kind: 'ready' });
  f.child.emit('message', { kind: 'result', value: { columns: {} } });
  f.setTime(5);
  f.child.emit('close', 0);
  await rejected;
  await retirement;
  expect(f.timings).toEqual([
    { stage: 'connectionStartup', durationMs: 2 },
    { stage: 'execution', durationMs: 3 },
  ]);
});
