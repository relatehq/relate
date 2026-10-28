import type { Row } from '../src/systems/simulators.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { Journal } from '../src/relate/journal.js';
import { agentLoop, cost } from '../src/harness/model.js';
import type { Model } from '../src/harness/model.js';
import type { ArmHandle } from '../src/harness/arms.js';
import { aggregate, paired } from '../src/report/aggregate.js';
import type { RunResult } from '../src/harness/run.js';

const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it('retains an unknown operation across journal restart and never repeats its create', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agency-journal-test-'));

  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let writes = 0;
  const first = new Journal(join(directory, 'journal.sqlite'));

  expect(
    await first.once(
      'op',
      async () => {
        writes++;
        throw Error('response lost');
      },
      async () => undefined,
    ),
  ).toBeUndefined();
  first.close();
  const second = new Journal(join(directory, 'journal.sqlite'));

  cleanup.push(() => second.close());
  expect(
    await second.once(
      'op',
      async () => {
        writes++;

        return { id: 'duplicate' };
      },
      async () => ({ id: 'original' }),
    ),
  ).toEqual({ id: 'original' });
  expect(writes).toBe(1);
});
it('counts cache tokens towards budgets and costs, and retains model failures', async () => {
  let calls = 0;
  const events: Row[] = [];
  const model: Model = {
    name: 'scripted',
    async complete() {
      calls++;

      return {
        stopReason: 'complete',
        content: [
          {
            type: 'tool_call',
            id: 'one',
            name: 'submit_answer',
            input: { answer: { ok: true }, caveats: [] },
          },
        ],
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 100,
          cacheWriteTokens: 4,
        },
      };
    },
  };
  const arm = {
    tools: [],
    async call() {
      throw Error('Should not execute after token budget');
    },
  } as unknown as ArmHandle;
  const result = await agentLoop({
    model,
    arm,
    system: 'system',
    prompt: 'task',
    emit: async (e) => {
      events.push(e);
    },
    budgets: { turns: 2, inputTokens: 10, wallMs: 1000 },
  });

  expect(result.submission).toBeUndefined();
  expect(result.stop).toBe('budget');
  expect(calls).toBe(1);
  expect(events.filter((e) => e.type === 'model')).toHaveLength(1);
  expect(
    cost(result.usage, {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    }),
  ).toEqual({ costUsd: 54 / 1e6, costUsdUncached: 242 / 1e6 });
  expect(cost(result.usage)).toEqual({ costUsd: null, costUsdUncached: null });
});
it('never executes a mutation after submit_answer', async () => {
  let writes = 0;
  const model: Model = {
    name: 'scripted',
    async complete() {
      return {
        stopReason: 'complete',
        content: [
          {
            type: 'tool_call',
            id: 'submit',
            name: 'submit_answer',
            input: { answer: {}, caveats: [] },
          },
          {
            type: 'tool_call',
            id: 'write',
            name: 'execute',
            input: { code: 'write' },
          },
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
  const arm = {
    tools: [],
    async call() {
      writes++;
    },
  } as unknown as ArmHandle;
  const result = await agentLoop({
    model,
    arm,
    system: 's',
    prompt: 'p',
    emit: async () => {},
  });

  expect(writes).toBe(0);
  expect(result.submission).toBeUndefined();
  expect(result.stop).toBe('invalid-after-submit');
});
it('includes failures in cost and distinguishes deferred/incomplete repetitions', () => {
  const row = (
    task: string,
    arm: 'relate' | 'baseline-code',
    repeat: number,
    passed: boolean,
    costUsd: number,
  ): RunResult => ({
    id: `${task}${arm}${repeat}`,
    task,
    arm,
    tier: 'S',
    seed: 7,
    repeat,
    category: 'lookup',
    status: 'completed',
    passed,
    costUsd,
    wallMs: 10,
    mistakes: passed ? [] : ['wrong-answer'],
  });
  const rows = [
    row('a', 'relate', 0, true, 2),
    row('a', 'relate', 1, false, 3),
    row('b', 'relate', 0, true, 4),
    row('a', 'baseline-code', 0, false, 1),
    row('a', 'baseline-code', 1, false, 1),
  ];
  const result = aggregate(rows, 2).find((r) => r.group === 'relate/S')!;

  expect(result.costPerSuccess).toBe(4.5);
  expect(result.passAllK).toBe(0);
  expect(result.incompleteTaskGroups).toBe(1);
  expect(paired(rows, 'relate', 'baseline-code', 2)).toMatchObject({
    pairedTasks: 1,
    difference: 0.5,
    interval95: [0.5, 0.5],
  });
});

it('marks usage unknown when a model request loses its response', async () => {
  const events: Row[] = [];
  const model: Model = {
    name: 'lost-response',
    async complete() {
      throw new Error('connection lost after request');
    },
  };
  const arm = {
    tools: [],
    async call() {
      throw new Error('not called');
    },
  } as unknown as ArmHandle;
  const result = await agentLoop({
    model,
    arm,
    system: 'system',
    prompt: 'task',
    emit: async (event) => {
      events.push(event);
    },
  });

  expect(result.stop).toBe('model-error');
  expect(result.usageComplete).toBe(false);
  expect(result.submission).toBeUndefined();
  expect(events.filter((e) => e.type === 'error')).toEqual([
    expect.objectContaining({
      type: 'error',
      error: 'Error: connection lost after request',
    }),
  ]);
  const failed = events.find(
    (e) => e.type === 'span-end' && e.kind === 'model',
  )!;

  expect(failed).toMatchObject({
    outcome: 'error',
    attributes: { costUsd: null, usageComplete: false },
  });
  expect(result.modelMs).toBe(failed.durationMs);
  expect(result.modelMs).toBeGreaterThan(0);
});
