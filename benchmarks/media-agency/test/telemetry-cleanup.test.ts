import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import * as environment from '../src/systems/environment.js';
import * as arms from '../src/harness/arms.js';
import { runOne } from '../src/harness/run.js';
import { catalogue } from '../src/tasks/catalogue.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const fn of cleanup.splice(0)) await fn();
});

it('preserves measured usage and step evidence when cleanup fails', async () => {
  const out = await mkdtemp(join(tmpdir(), 'agency-cleanup-'));

  cleanup.push(() => rm(out, { recursive: true, force: true }));
  vi.spyOn(environment, 'createEnvironment').mockResolvedValue({
    mutations: [],
    db: { calls: [] },
    simulators: { requests: [] },
    close: async () => {
      throw Error('cleanup failed');
    },
  } as unknown as environment.Environment);
  vi.spyOn(arms, 'createArm').mockResolvedValue({
    tools: [],
    close: async () => {},
  } as unknown as arms.ArmHandle);
  const result = await runOne({
    task: catalogue.find((t) => t.status === 'ready')!,
    arm: 'baseline-tools',
    tier: 'S',
    seed: 7,
    repeat: 0,
    manifestId: 'cleanup',
    out,
    price: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    model: {
      name: 'test',
      async complete() {
        return {
          content: [
            {
              type: 'tool_call',
              name: 'submit_answer',
              id: 'answer',
              input: { answer: {}, caveats: [] },
            },
          ],
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          stopReason: 'complete',
        };
      },
    },
  });

  expect(result).toMatchObject({
    status: 'failed',
    passed: false,
    mistakes: expect.arrayContaining(['cleanup-error']),
    inputTokens: 3,
    outputTokens: 2,
    costUsd: 0.000005,
    turns: 1,
    toolCalls: 1,
  });
  const events = (await readFile(join(out, `${result.id}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

  expect(
    events.find(
      (e) => e.type === 'span-end' && e.name === 'environment-cleanup',
    ),
  ).toMatchObject({ outcome: 'error', error: 'Error: cleanup failed' });
});
