import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, onTestFinished } from 'vitest';
import { createProcessRunner } from '../dist/process.js';
import type { DuckDBDiagnostic } from '../src/process.js';
import type { AnalyticalOperation } from '../src/messages.js';

function setup(path = 'normal', startupTimeoutMs = 1000) {
  const diagnostics: DuckDBDiagnostic[] = [];
  const runner = createProcessRunner({
    path,
    startupTimeoutMs,
    workerUrl: new URL('./fixtures/worker.mjs', import.meta.url),
    onDiagnostic: (item) => diagnostics.push(item),
  });

  onTestFinished(() => runner.close());

  return { runner, diagnostics };
}

const operation = (table = 'normal'): AnalyticalOperation => ({
  kind: 'describe',
  resource: { table, schema: 'main', columns: {} },
});
const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
});

it('reuses a completed worker after the previous statement deadline and late caller abort', async () => {
  const { runner } = setup();
  const controller = new AbortController();
  const first = await runner.run(operation(), {
    signal: controller.signal,
    timeoutMs: 100,
  });

  await delay(150);
  controller.abort();
  const second = await runner.run(operation(), options());

  expect(second).toMatchObject({ rows: (first as { rows: unknown }).rows });
});

it.each(['abort', 'timeout'] as const)(
  'replaces only the affected worker after %s',
  async (mode) => {
    const { runner } = setup();
    const initial = await runner.run(operation(), options());
    const controller = new AbortController();
    const pending = runner.run(operation('hang'), {
      signal: controller.signal,
      timeoutMs: mode === 'timeout' ? 30 : 1000,
    });
    const rejected = expect(pending).rejects.toMatchObject(
      mode === 'abort'
        ? { name: 'AbortError' }
        : {
            code: 'execution-failed',
            cause: { message: 'DuckDB execution timed out' },
          },
    );

    if (mode === 'abort') controller.abort();

    await rejected;
    const next = await runner.run(operation(), options());

    expect((next as { rows: unknown }).rows).not.toEqual(
      (initial as { rows: unknown }).rows,
    );
  },
);

it('bounds concurrent workers and awaits every child on retirement', async () => {
  const { runner } = setup();
  const pending = Array.from({ length: 4 }, () =>
    runner.run(operation('hang'), options()),
  );
  const outcomes = pending.map((promise) =>
    expect(promise).rejects.toMatchObject({ name: 'AbortError' }),
  );

  await expect(runner.run(operation(), options())).rejects.toMatchObject({
    retryable: true,
  });
  await runner.close();
  await Promise.all(outcomes);
  await expect(runner.run(operation(), options())).rejects.toMatchObject({
    retryable: false,
  });
});

it('reports bounded native crash details only through internal cause and host diagnostics', async () => {
  const { runner, diagnostics } = setup('crash');
  const error = await runner
    .run(operation(), options())
    .catch((error) => error);

  expect(error.cause.message).toContain('native crash marker');
  expect(error.message).toBe('Analytical execution failed');
  expect(JSON.stringify(error)).not.toContain('native crash marker');
  expect(diagnostics).toEqual([
    expect.objectContaining({
      kind: 'crash',
      message: expect.stringContaining('native crash marker'),
    }),
  ]);
});

it('distinguishes startup deadlines and handles cancellation in timing observers', async () => {
  const { runner, diagnostics } = setup('startup-timeout', 20);

  await expect(runner.run(operation(), options())).rejects.toMatchObject({
    code: 'execution-failed',
    cause: { message: 'DuckDB connectionStartup timed out' },
  });
  expect(diagnostics[0]!.kind).toBe('timeout');
  const healthy = setup().runner;
  const controller = new AbortController();
  const stages: string[] = [];

  await expect(
    healthy.run(operation(), {
      signal: controller.signal,
      timeoutMs: 1000,
      onTiming(timing) {
        stages.push(timing.stage);
        controller.abort();
      },
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(stages).toEqual(['connectionStartup']);
});

it('keeps a healthy idle worker when a different worker is cancelled', async () => {
  const { runner } = setup();
  const controller = new AbortController();
  const pending = runner.run(operation('hang'), {
    ...options(),
    signal: controller.signal,
  });
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  const healthy = await runner.run(operation(), options());

  controller.abort();
  await rejected;
  const reused = await runner.run(operation(), options());

  expect((reused as { rows: unknown }).rows).toEqual(
    (healthy as { rows: unknown }).rows,
  );
});
