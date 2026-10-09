import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { runEpisode } from '../episode.js';
import { goals } from '../goals.js';
import { scriptedModel } from '../model.js';
import { repositoryRoot } from '../session.js';
import { summarize } from '../summarize.js';

const episode = (goalId: string, cells: string[], maxTurns = 4) =>
  runEpisode({
    goal: goals.find((goal) => goal.id === goalId)!,
    model: scriptedModel(cells),
    checkout: repositoryRoot,
    sdk: 'current',
    repeat: 0,
    maxTurns,
  });

it('solves every goal with its reference solution on the current SDK', async () => {
  const results = await Promise.all(
    goals.map((goal) => episode(goal.id, [goal.reference])),
  );

  expect(
    results.map((r) => [r.goal, r.success, r.clean, r.termination]),
  ).toEqual(goals.map((goal) => [goal.id, true, true, 'submitted']));
  expect(
    results.find((r) => r.goal === 'traverse-through')!.operations,
  ).toEqual(['objects.Ticket.query', 'objects.Ticket.traverse.agents']);
  // The prelude's failure is shown to the agent but not counted against it.
  expect(results.at(-1)!.prelude?.output).toContain(
    'pageSize: unknown option; use "limit"',
  );
}, 60_000);

it('scores wrong answers, failed cells and SDK errors without passing them', async () => {
  const result = await episode('count-all', [
    'await relate.objects.Ticket.query({ pageSize: 5 })',
    'submit(25)',
  ]);

  expect(result).toMatchObject({
    success: false,
    clean: false,
    termination: 'submitted',
    turns: 2,
    failedCells: 1,
    sdkErrors: [
      expect.stringMatching(
        /^objects\.Ticket\.query: ReadError: invalid-request in Ticket\.query:$/,
      ),
    ],
  });
  expect(summarize([result]).rows.at(-1)).toMatchObject({
    goal: 'all',
    success: '0/1',
    meanSdkErrors: 1,
  });
}, 30_000);

it('lets a later cell redeclare a top-level name, as in a notebook', async () => {
  const result = await episode('count-all', [
    'const total: number = 1; let seen = 0;',
    'const total = 64; let seen = total; { const total = 0; }',
    'submit(total)',
  ]);

  expect(result).toMatchObject({ success: true, clean: true, failedCells: 0 });
}, 30_000);

it('ends at the turn budget or when the model stops calling the tool', async () => {
  expect((await episode('count-all', ['1', '2', '3'], 2)).termination).toBe(
    'turn-budget',
  );
  expect((await episode('count-all', [])).termination).toBe('model-no-action');
}, 30_000);

it('keeps host credentials and files outside the agent sandbox', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'probe-secret-'));
  const file = join(folder, 'credentials.env');

  onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(file, 'OPENAI_API_KEY=file-secret');
  process.env.OPENAI_API_KEY = 'env-secret';
  onTestFinished(() => {
    delete process.env.OPENAI_API_KEY;
  });

  const result = await episode('count-all', [
    `console.log(typeof process, typeof require);
// The REPL context is not a boundary: host-realm objects reach the real process.
const host = relate.describe.constructor('return process')();
console.log(JSON.stringify(host.env));
try { host.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'); }
catch (error) { console.log(error.code); }`,
  ]);
  const output = result.steps[0]!.result.output;

  expect(output).toContain('undefined undefined');
  // The escape reached the child's process, whose environment is PATH only.
  expect(output).toContain('{"PATH":');
  expect(output).toContain('ERR_ACCESS_DENIED');
  expect(output).not.toContain('secret');
}, 30_000);

it('records calls without changing how operations print', async () => {
  const result = await episode('count-all', [
    'console.log(String(relate.objects.Ticket.traverse.agents)); console.log(Object.keys(relate.describe()))',
  ]);

  expect(result.steps[0]!.result.output).toMatch(
    /^objects\.Ticket\.traverse\.agents\(id: ObjectId<Ticket>, options\?: \{ select\?, limit\?, cursor\?/,
  );
  expect(result.steps[0]!.result.output).toContain('operations');
  expect(result.operations).toEqual(['describe']);
}, 30_000);
