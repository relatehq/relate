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
  const task = catalogue.find((t) => t.status === 'deferred')!;
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
