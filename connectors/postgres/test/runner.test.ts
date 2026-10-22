import { expect, it, vi } from 'vitest';
import { createRunner } from '../src/runner.js';
import type { StatementClient } from '../src/client.js';
import type { AnalyticalExecutionTiming } from 'relate/connectors';

const settings = {
  url: 'postgres://localhost/test',
  startupTimeoutMs: 100,
  cancelTimeoutMs: 100,
};

function gate<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

function client(overrides: Partial<StatementClient> = {}): StatementClient {
  return {
    connect: async () => {},
    query: async (sql) =>
      sql.includes('pg_backend_pid')
        ? [['123']]
        : sql.includes('pg_cancel_backend')
          ? [['t']]
          : [],
    cancel: async () => {},
    end: async () => {},
    destroy: () => {},
    ...overrides,
  };
}

const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
});

it('closes startup failures without entering execution, including constructor failures', async () => {
  for (const constructor of [false, true]) {
    const timings: AnalyticalExecutionTiming[] = [];
    let closed = false;
    const runner = createRunner(settings, () => {
      if (constructor) throw new Error('secret connection failure');

      return client({
        connect: async () => {
          throw new Error('secret credentials');
        },
        end: async () => {
          closed = true;
        },
      });
    });

    await expect(
      runner.run(async () => 1, {
        ...options(),
        onTiming: (timing) => timings.push(timing),
      }),
    ).rejects.toMatchObject({ message: 'Analytical execution failed' });
    expect(closed).toBe(!constructor);
    expect(timings.map((timing) => timing.stage)).toEqual([
      'connectionStartup',
    ]);
    await runner.close();
  }
});

it('bounds a stalled startup and awaits socket cleanup', async () => {
  const connected = gate();
  let closed = false;
  const timings: AnalyticalExecutionTiming[] = [];
  const runner = createRunner({ ...settings, startupTimeoutMs: 5 }, () =>
    client({
      connect: () => connected.promise,
      destroy: () => connected.reject(new Error('disconnected')),
      end: async () => {
        closed = true;
      },
    }),
  );

  await expect(
    runner.run(async () => 1, {
      ...options(),
      onTiming: (timing) => timings.push(timing),
    }),
  ).rejects.toMatchObject({ code: 'execution-failed' });
  expect(closed).toBe(true);
  expect(timings.map((timing) => timing.stage)).toEqual(['connectionStartup']);
  await runner.close();
});

it('retains capacity after a control failure until the primary statement settles', async () => {
  const statement = gate<number>(),
    started = gate();
  let primaryClosed = false,
    controlClosed = false,
    settled = false;
  const controller = new AbortController();
  const runner = createRunner(settings, (purpose) =>
    purpose === 'control'
      ? client({
          connect: async () => {
            throw new Error('control network lost');
          },
          end: async () => {
            controlClosed = true;
          },
        })
      : client({
          end: async () => {
            primaryClosed = true;
          },
        }),
  );
  const result = runner
    .run(
      async () => {
        started.resolve();

        return statement.promise;
      },
      { ...options(), signal: controller.signal },
    )
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });

  await started.promise;
  const reason = new Error('caller abort');

  controller.abort(reason);
  await vi.waitFor(() => expect(controlClosed).toBe(true));
  expect(primaryClosed).toBe(false);
  expect(settled).toBe(false);
  statement.reject(
    Object.assign(new Error('server timeout'), { code: '57014' }),
  );
  expect(await result).toBe(reason);
  expect(primaryClosed).toBe(true);
  await runner.close();
});

it('joins a control request started during primary cleanup and prevents late publication', async () => {
  const ending = gate(),
    endStarted = gate(),
    controlQuery = gate<readonly (readonly (string | null)[])[]>();
  let controlClosed = false,
    settled = false;
  const controller = new AbortController();
  const runner = createRunner(settings, (purpose) =>
    purpose === 'control'
      ? client({
          cancel: async () => {
            await controlQuery.promise;
          },
          end: async () => {
            controlClosed = true;
          },
        })
      : client({
          end: () => {
            endStarted.resolve();

            return ending.promise;
          },
        }),
  );
  const result = runner
    .run(async () => 42, { ...options(), signal: controller.signal })
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });

  await endStarted.promise;
  controller.abort(new Error('late abort'));
  ending.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  controlQuery.resolve([['t']]);
  expect(await result).toMatchObject({ message: 'late abort' });
  expect(controlClosed).toBe(true);
  await runner.close();
});

it('uses fresh clients, enforces bounded concurrency and ignores timing observer failures', async () => {
  const pending = gate();
  let opened = 0,
    closed = 0;
  const runner = createRunner(settings, () => {
    opened++;

    return client({
      end: async () => {
        closed++;
      },
    });
  });
  const active = Array.from({ length: 4 }, () =>
    runner.run(
      async () => {
        await pending.promise;

        return 42;
      },
      {
        ...options(),
        onTiming: async () => {
          throw new Error('observer');
        },
      },
    ),
  );

  await expect(runner.run(async () => 0, options())).rejects.toMatchObject({
    retryable: true,
  });
  pending.resolve();
  expect(await Promise.all(active)).toEqual([42, 42, 42, 42]);
  expect(closed).toBe(4);
  expect(await runner.run(async () => 43, options())).toBe(43);
  expect(opened).toBe(5);
  expect(closed).toBe(5);
  await runner.close();
});

it('does not enter execution when the startup observer aborts the operation', async () => {
  const controller = new AbortController();
  const timings: AnalyticalExecutionTiming[] = [];
  let executions = 0;
  const runner = createRunner(settings, () => client());

  await expect(
    runner.run(
      async () => {
        executions++;

        return 1;
      },
      {
        ...options(),
        signal: controller.signal,
        onTiming: (timing) => {
          timings.push(timing);
          controller.abort(new Error('stop'));
        },
      },
    ),
  ).rejects.toThrow('stop');
  expect(executions).toBe(0);
  expect(timings.map((timing) => timing.stage)).toEqual(['connectionStartup']);
  await runner.close();
});

it('sanitizes cleanup failures and withholds an otherwise successful result', async () => {
  const runner = createRunner(settings, () =>
    client({
      end: async () => {
        throw new Error('private driver details');
      },
    }),
  );

  await expect(runner.run(async () => 42, options())).rejects.toMatchObject({
    message: 'Analytical execution failed',
    code: 'execution-failed',
  });
  await runner.close();
});
