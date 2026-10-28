import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { prepareRun, runOne } from '../src/harness/run.js';
import type { RunConfig } from '../src/harness/run.js';
import { catalogue } from '../src/tasks/catalogue.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
it('resumes only the identical manifest and records deferred tasks without executing them', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agency-resume-test-'));

  cleanup.push(() => rm(out, { recursive: true, force: true }));
  // No catalogued task is deferred today; the runner must still record one without executing it.
  const task = {
    ...catalogue[0]!,
    id: 'test.deferred-1',
    status: 'deferred' as const,
    reason: 'reference-datasets: test-only deferred entry',
  };
  const config: RunConfig = {
    tier: 'S',
    seed: 7,
    arms: ['relate'],
    model: 'reference',
    k: 1,
    tasks: [task.id],
    mode: 'reference',
  };
  const first = await prepareRun(out, config);

  expect((await prepareRun(out, config)).id).toBe(first.id);
  await expect(prepareRun(out, { ...config, seed: 19 })).rejects.toThrow(
    'Resume refused',
  );
  await expect(
    prepareRun(out, { ...config, model: 'different' }),
  ).rejects.toThrow('Resume refused');

  for (const modelConfig of [
    {
      provider: 'openai' as const,
      model: 'test',
      maxOutputTokens: 8192,
      reasoning: 'low' as const,
    },
    { provider: 'anthropic' as const, model: 'test', maxOutputTokens: 8192 },
  ])
    await expect(prepareRun(out, { ...config, modelConfig })).rejects.toThrow(
      'Resume refused',
    );

  const result = await runOne({
    task,
    arm: 'relate',
    tier: 'S',
    seed: 7,
    repeat: 0,
    out,
    manifestId: first.id,
  });

  expect(result.status).toBe('deferred');
  expect(result).not.toHaveProperty('passed');
  expect(
    await runOne({
      task,
      arm: 'relate',
      tier: 'S',
      seed: 7,
      repeat: 0,
      out,
      manifestId: first.id,
    }),
  ).toEqual(result);
  expect(
    JSON.parse(await readFile(join(out, `${result.id}.result.json`), 'utf8'))
      .reason,
  ).toContain('reference-datasets');
});

it.each(['baseline-tools', 'baseline-code', 'relate'] as const)(
  'injects and records the lost-response fault through the real runner for %s',
  async (arm) => {
    const out = await mkdtemp(join(tmpdir(), 'agency-fault-run-'));

    cleanup.push(() => rm(out, { recursive: true, force: true }));
    const task = catalogue.find((t) => t.id === 'action.create-2')!;
    const result = await runOne({
      task,
      arm,
      tier: 'S',
      seed: 19,
      repeat: 0,
      out,
      manifestId: 'fault-regression',
    });

    expect(result).toMatchObject({
      status: 'completed',
      passed: true,
      mutations: 1,
      writeAttempts: 1,
    });
    expect(result.faultOutcomes).toEqual([
      expect.objectContaining({
        system: 'tiktok',
        outcome: 'timeout-after-commit',
      }),
    ]);
    const events = (await readFile(join(out, `${result.id}.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const end = events.find((e) => e.type === 'end-state');

    expect(
      end.requests.filter(
        (r: { outcome: string }) => r.outcome === 'timeout-after-commit',
      ),
    ).toHaveLength(1);
    expect(end.mutations).toHaveLength(1);
    const starts = events.filter((e) => e.type === 'span-start');
    const spans = events.filter((e) => e.type === 'span-end');

    expect(spans).toHaveLength(starts.length);
    expect(events.map((e) => e.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    const lost = spans.find(
      (e) =>
        e.kind === 'http' &&
        e.attributes.simulatorOutcome === 'timeout-after-commit',
    );

    expect(lost).toMatchObject({
      outcome: 'error',
      attributes: { mutationCount: 1, requestId: end.mutations[0].requestId },
    });
    // This catches executor IPC callbacks accidentally retaining the closed setup context.
    const parent = spans.find((e) => e.spanId === lost.parentSpanId);

    expect(parent.kind).toBe('tool');

    if (arm === 'relate')
      expect(spans.some((e) => e.kind === 'sql')).toBe(true);

    expect(spans.filter((e) => e.kind === 'phase').map((e) => e.name)).toEqual(
      expect.arrayContaining([
        'environment-setup',
        'arm-setup',
        'drain',
        'grading',
        'environment-cleanup',
      ]),
    );
    expect(result.telemetry).toMatchObject({
      version: 1,
      unfinished: [],
      events: events.length,
    });

    for (const span of spans) {
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(Date.parse(span.startedAt))).toBe(true);
      expect(Number.isFinite(Date.parse(span.endedAt))).toBe(true);
    }
  },
  30000,
);
