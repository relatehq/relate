import { AsyncResource } from 'node:async_hooks';
import { mkdtemp, appendFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Trace } from '../src/harness/telemetry.js';
import type { Row } from '../src/systems/simulators.js';
import { readTelemetry } from '../src/report/telemetry.js';
import { agentLoop } from '../src/harness/model.js';
import type { ArmHandle } from '../src/harness/arms.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it('uses monotonic durations, orders parallel writes and attributes IPC work to its active tool', async () => {
  const events: Row[] = [];
  let monotonic = 0;
  let date = '2026-10-28T12:00:00.000Z';
  const trace = new Trace(
    async (event) => {
      events.push(event);
    },
    'run',
    { now: () => monotonic, iso: () => date },
  );
  let callback: (() => Promise<unknown>) | undefined;

  await trace.span(
    'phase',
    'arm-setup',
    {},
    () => {
      callback = AsyncResource.bind(() =>
        Promise.all([
          trace.span('http', 'meta', {}, () => {
            monotonic += 2;
          }),
          trace.span('sql', 'plans', {}, () => {
            monotonic += 3;
          }),
        ]),
      );
    },
    true,
  );
  await trace.span(
    'tool',
    'execute',
    {},
    async () => {
      // A backwards wall-clock jump cannot make duration negative.
      date = '2026-10-28T11:00:00.000Z';
      await callback!();
    },
    true,
  );
  const ends = events.filter((e) => e.type === 'span-end');
  const tool = ends.find((e) => e.kind === 'tool')!;

  expect(tool.durationMs).toBe(5);
  expect(
    ends
      .filter((e) => ['sql', 'http'].includes(String(e.kind)))
      .map((e) => e.parentSpanId),
  ).toEqual([tool.spanId, tool.spanId]);
  expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => i + 1));
  expect(trace.summary().unfinished).toEqual([]);
  expect(trace.summary().maxObservedRssBytes).toBeGreaterThan(0);
});

it('reports unfinished and malformed traces while leaving legacy timing unknown', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agency-telemetry-'));

  cleanup.push(() => rm(out, { recursive: true, force: true }));
  await writeFile(join(out, 'old.jsonl'), '{"type":"model"}\n');
  const file = join(out, 'new.jsonl');
  const trace = new Trace(
    async (event) => appendFile(file, JSON.stringify(event) + '\n'),
    'run',
  );

  await trace.emit({ type: 'start', identity: { arm: 'relate', tier: 'S' } });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = trace.span('model', 'test', {}, async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  await ready;
  const incomplete = await readTelemetry(out);

  expect(incomplete).toMatchObject({
    instrumentedTranscripts: 1,
    legacyTranscripts: 1,
    steps: [],
    malformed: [],
  });
  expect(incomplete.unfinished).toHaveLength(1);
  release();
  await pending;
  await appendFile(file, '{"partial":');
  const complete = await readTelemetry(out);

  expect(complete.unfinished).toEqual([]);
  expect(complete.malformed).toHaveLength(1);
  expect(complete.steps).toEqual([
    expect.objectContaining({
      group: 'relate/S/measured/model/test',
      count: 1,
      errors: 0,
      medianMs: expect.any(Number),
    }),
  ]);
});

it('retains aborted model duration and unknown cost without dispatching a tool', async () => {
  const events: Row[] = [];
  const result = await agentLoop({
    model: {
      name: 'abort',
      async complete() {
        throw new DOMException('cancelled', 'AbortError');
      },
    },
    arm: {
      tools: [],
      call: async () => {
        throw Error('must not dispatch');
      },
    } as unknown as ArmHandle,
    system: 'rules',
    prompt: 'task',
    emit: async (event) => {
      events.push(event);
    },
  });

  expect(result.usageComplete).toBe(false);
  expect(result.toolCalls).toBe(0);
  expect(
    events.find((e) => e.type === 'span-end' && e.kind === 'model'),
  ).toMatchObject({
    outcome: 'aborted',
    durationMs: result.modelMs,
    attributes: { costUsd: null, usageComplete: false },
  });
});

it('times successful and failed SQL through the actual database path', async () => {
  const { createEnvironment } = await import('../src/systems/environment.js');
  const { generateWorld } = await import('../src/world/generator.js');
  const events: Row[] = [];
  const trace = new Trace(async (event) => {
    events.push(event);
  });
  const env = await createEnvironment(
    generateWorld({ tier: 'S', seed: 7 }),
    [],
    trace,
  );

  cleanup.push(env.close);
  await trace.span(
    'tool',
    'sql_query',
    {},
    async () => {
      expect(await env.db.sql('plans', 'SELECT ? AS value', [42])).toEqual([
        { value: 42 },
      ]);
      await expect(
        env.db.sql('plans', 'SELECT * FROM missing_table'),
      ).rejects.toThrow();
    },
    true,
  );
  const sql = events.filter((e) => e.type === 'span-end' && e.kind === 'sql');

  expect(sql).toHaveLength(2);
  expect(sql[0]).toMatchObject({
    outcome: 'ok',
    attributes: { params: [42], rowCount: 1, outputBytes: 14 },
  });
  expect(sql[1]).toMatchObject({
    outcome: 'error',
    error: expect.stringContaining('missing_table'),
  });
  expect(sql[0]!.parentSpanId).toBe(sql[1]!.parentSpanId);
});
