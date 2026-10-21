import { afterEach, expect, it, vi } from 'vitest';
import {
  AnalyticalBusyError,
  createStatementQueue,
} from '../src/analytics/index.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

function signal() {
  return new AbortController().signal;
}

const turn = async () => {
  for (let index = 0; index < 5; index++) await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

it('defaults to four running statements and 32 waiting across callers', async () => {
  const queue = createStatementQueue();
  const gate = deferred();
  const started: number[] = [];
  const tasks = Array.from({ length: 36 }, (_, index) =>
    queue.run(
      async () => {
        started.push(index);
        await gate.promise;

        return index;
      },
      { signal: signal() },
    ),
  );
  const overflow = queue.run(async () => -1, { signal: signal() });

  await expect(overflow).rejects.toMatchObject({
    reason: 'queue-full',
    retryable: true,
  });
  expect(started).toEqual([0, 1, 2, 3]);
  gate.resolve();
  expect(await Promise.all(tasks)).toEqual(
    Array.from({ length: 36 }, (_, index) => index),
  );
  await queue.retire();
});

it('admits waiting statements FIFO as individual slots become free', async () => {
  const queue = createStatementQueue({ concurrency: 2 });
  const gates = Array.from({ length: 4 }, () => deferred());
  const started: number[] = [];
  const tasks = gates.map((gate, index) =>
    queue.run(
      async () => {
        started.push(index);
        await gate.promise;
      },
      { signal: signal() },
    ),
  );

  await turn();
  expect(started).toEqual([0, 1]);

  gates[1]!.resolve();
  await tasks[1];
  await turn();
  expect(started).toEqual([0, 1, 2]);
  gates[0]!.resolve();
  await tasks[0];
  await turn();
  expect(started).toEqual([0, 1, 2, 3]);
  gates[2]!.resolve();
  gates[3]!.resolve();
  await Promise.all(tasks);
  await queue.retire();
});

it('cancels a queued caller without executing it and makes waiting capacity available', async () => {
  const queue = createStatementQueue({ concurrency: 1, maxQueued: 1 });
  const gate = deferred();
  const first = queue.run(() => gate.promise, { signal: signal() });
  const caller = new AbortController();
  const task = vi.fn(async () => 2);
  const cancelled = queue
    .run(task, { signal: caller.signal })
    .catch((error: unknown) => error);
  const reason = new Error('caller stopped');

  caller.abort(reason);
  expect(await cancelled).toBe(reason);
  const replacement = queue.run(async () => 3, { signal: signal() });

  gate.resolve();
  await first;
  expect(await replacement).toBe(3);
  expect(task).not.toHaveBeenCalled();
  await queue.retire();
});

it('expires the wait after two seconds without applying that clock to running work', async () => {
  vi.useFakeTimers();
  const queue = createStatementQueue({ concurrency: 1 });
  const gate = deferred();
  const first = queue.run(() => gate.promise, { signal: signal() });
  const task = vi.fn(async () => 2);
  let result: unknown;
  const waiting = queue
    .run(task, { signal: signal() })
    .catch((error: unknown) => {
      result = error;
    });

  await vi.advanceTimersByTimeAsync(1999);
  expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(result).toMatchObject({ reason: 'queue-timeout', retryable: true });
  expect(task).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  gate.resolve();
  await first;
  await queue.retire();
});

it('keeps capacity until aborted work finishes cleanup and rejects its late result', async () => {
  const queue = createStatementQueue({ concurrency: 1 });
  const gate = deferred();
  const caller = new AbortController();
  let runningSignal: AbortSignal | undefined;
  const first = queue
    .run(
      async (signal) => {
        runningSignal = signal;
        await gate.promise;

        return 'late value';
      },
      { signal: caller.signal },
    )
    .catch((error: unknown) => error);
  const next = vi.fn(async () => 'next');
  const second = queue.run(next, { signal: signal() });

  await turn();
  const reason = new Error('cancelled');

  caller.abort(reason);
  await turn();
  expect(runningSignal?.aborted).toBe(true);
  expect(next).not.toHaveBeenCalled();
  gate.resolve();
  expect(await first).toBe(reason);
  expect(await second).toBe('next');
  await queue.retire();
});

it('retires once, cancels queued work and drains running cleanup before disposal', async () => {
  const queue = createStatementQueue({ concurrency: 1 });
  const cleanup = deferred();
  let runningSignal: AbortSignal | undefined;
  const first = queue
    .run(
      async (signal) => {
        runningSignal = signal;
        await cleanup.promise;
      },
      { signal: signal() },
    )
    .catch((error: unknown) => error);
  const pendingTask = vi.fn(async () => undefined);
  const second = queue
    .run(pendingTask, { signal: signal() })
    .catch((error: unknown) => error);

  await turn();
  let drained = false;

  const retirement = queue.retire();

  void retirement.then(() => {
    drained = true;
  });
  expect(queue.retire()).toBe(retirement);
  await turn();
  expect(runningSignal?.aborted).toBe(true);
  expect(await second).toMatchObject({ name: 'AbortError' });
  expect(drained).toBe(false);
  await expect(
    queue.run(async () => 1, { signal: signal() }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  cleanup.resolve();
  expect(await first).toMatchObject({ name: 'AbortError' });
  await retirement;
  expect(drained).toBe(true);
  expect(pendingTask).not.toHaveBeenCalled();
});

it.each(['throw', 'reject'] as const)(
  'releases capacity after a task %s',
  async (failure) => {
    const queue = createStatementQueue({ concurrency: 1 });
    const reason = new Error('driver failure');
    const first = queue.run(
      () => {
        if (failure === 'throw') throw reason;

        return Promise.reject(reason);
      },
      { signal: signal() },
    );
    const second = queue.run(async () => 2, { signal: signal() });

    await expect(first).rejects.toBe(reason);
    expect(await second).toBe(2);
    await queue.retire();
  },
);

it('does not execute work cancelled before task startup', async () => {
  const queue = createStatementQueue();
  const caller = new AbortController();
  const task = vi.fn(async () => 1);
  const first = queue.run(task, { signal: caller.signal });

  caller.abort('stopped');
  const second = queue.run(task, { signal: caller.signal });

  await expect(first).rejects.toBe('stopped');
  await expect(second).rejects.toBe('stopped');
  expect(task).not.toHaveBeenCalled();
  await queue.retire();
});

it.each([
  [{ maxQueued: 0 }, 'queue-full'],
  [{ maxWaitMs: 0 }, 'queue-timeout'],
] as const)('can disable waiting with %j', async (limits, reason) => {
  const queue = createStatementQueue({ concurrency: 1, ...limits });
  const gate = deferred();
  const first = queue.run(() => gate.promise, { signal: signal() });

  await expect(
    queue.run(async () => 1, { signal: signal() }),
  ).rejects.toMatchObject({ reason });
  gate.resolve();
  await first;
  await queue.retire();
});

it.each([
  { concurrency: 0 },
  { concurrency: 1.5 },
  { concurrency: Infinity },
  { maxQueued: -1 },
  { maxQueued: NaN },
  { maxWaitMs: -1 },
  { maxWaitMs: 2147483648 },
  { maxWaitMs: 0.5 },
])('rejects unsafe host limits %j', (limits) => {
  expect(() => createStatementQueue(limits)).toThrow(
    'Invalid analytical queue limits',
  );
});

it('clears wait timers and abort listeners when a statement is admitted and settles', async () => {
  vi.useFakeTimers();
  const queue = createStatementQueue({ concurrency: 1 });
  const gate = deferred();
  const first = queue.run(() => gate.promise, { signal: signal() });
  const caller = new AbortController();
  const remove = vi.spyOn(caller.signal, 'removeEventListener');
  const second = queue.run(async () => 2, { signal: caller.signal });

  expect(vi.getTimerCount()).toBe(1);

  gate.resolve();
  await first;
  expect(await second).toBe(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  await queue.retire();
});

it('keeps busy errors free of caller or backend data', () => {
  const error = new AnalyticalBusyError('queue-full');

  expect(error.message).toBe('Analytical connection is busy');
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    name: 'AnalyticalBusyError',
    reason: 'queue-full',
    retryable: true,
  });
});
