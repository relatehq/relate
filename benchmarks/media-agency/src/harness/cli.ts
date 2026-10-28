import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { catalogue } from '../tasks/catalogue.js';
import { arms } from './arms.js';
import type { Arm } from './arms.js';
import {
  benchmarkRoot,
  manifest as currentManifest,
  prepareRun,
  readResults,
  runOne,
} from './run.js';
import type { RunConfig } from './run.js';
import { generateWorld } from '../world/generator.js';
import { writeDatabases } from '../systems/databases.js';
import { json } from '../world/model.js';
import { anthropicModel } from './model.js';
import type { Price } from './model.js';
import { aggregate, paired, renderReport } from '../report/aggregate.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tier: { type: 'string', default: 'S' },
    seed: { type: 'string', default: '7' },
    arm: { type: 'string', default: 'all' },
    stage: { type: 'string', default: 'pilot' },
    model: { type: 'string' },
    task: { type: 'string' },
    k: { type: 'string', short: 'k', default: '1' },
    out: { type: 'string' },
    pricing: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const command = positionals[0];

if (values.help || !command) {
  console.log(
    'Commands: catalogue, generate, validate, run, report. Options: --tier S|M|L --seed 7 --arm all|baseline-tools|baseline-code|relate --stage pilot|main|scale --task category.* -k 1 --model MODEL --pricing JSON_FILE --out DIRECTORY. validate uses reference solutions without model calls. run requires --model and ANTHROPIC_API_KEY. Report reads the immutable manifest.',
  );
  process.exit(0);
}

const out = resolve(
  resolve(benchmarkRoot, '../..'),
  values.out ??
    join(
      benchmarkRoot,
      'artifacts',
      command === 'validate'
        ? 'validation'
        : command === 'generate'
          ? 'world'
          : 'run',
    ),
);

if (command === 'catalogue') {
  console.log(json(catalogue));
  process.exit(0);
}

if (command === 'report') {
  const manifest = JSON.parse(
    await readFile(join(out, 'manifest.json'), 'utf8'),
  ) as {
    id: string;
    config: RunConfig;
    catalogue: {
      id: string;
      status: string;
      reason?: string;
      category: string;
    }[];
  };
  const results = await readResults(out),
    config = manifest.config;
  let invalidated = false;

  try {
    await access(join(out, 'invalidated.json'));
    invalidated = true;
  } catch {}

  if (invalidated)
    throw new Error(
      'This run was invalidated by source changes; retained for debugging, not reportable.',
    );

  const savedCatalogue = manifest.catalogue;
  const selected = savedCatalogue.filter((t) => config.tasks.includes(t.id));
  const identities = new Set<string>();

  for (const result of results) {
    const identity = `${result.task}/${result.arm}/${result.repeat}`;

    if (
      result.manifest !== manifest.id ||
      !config.tasks.includes(result.task) ||
      !config.arms.includes(result.arm) ||
      result.tier !== config.tier ||
      result.seed !== config.seed ||
      result.repeat < 0 ||
      result.repeat >= config.k ||
      identities.has(identity)
    )
      throw new Error(
        'Result does not belong to this manifest or duplicates a scheduled run',
      );

    identities.add(identity);
  }

  const report = {
    mode: config.mode,
    intendedTasks: savedCatalogue.length,
    runnableTasks: savedCatalogue.filter((t) => t.status === 'ready').length,
    deferredTasks: savedCatalogue.filter((t) => t.status === 'deferred'),
    selectedTasks: selected.length,
    missingRuns:
      config.tasks.length * config.arms.length * config.k - results.length,
    summary: aggregate(results, config.k),
    comparisons: [
      paired(results, 'relate', 'baseline-code', config.k),
      paired(results, 'relate', 'baseline-tools', config.k),
    ],
    byCategory: Object.fromEntries(
      [...new Set(savedCatalogue.map((t) => t.category))].map((category) => [
        category,
        aggregate(
          results.filter((r) => r.category === category),
          config.k,
        ),
      ]),
    ),
  };

  await writeFile(
    join(out, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  await writeFile(join(out, 'report.md'), renderReport(report));
  console.log(join(out, 'report.md'));
  process.exit(0);
}

const tier = z.enum(['S', 'M', 'L']).parse(values.tier),
  seed = Number(values.seed),
  k = Number(values.k);

if (!Number.isSafeInteger(k) || k < 1 || k > 100)
  throw new Error('-k must be 1..100');

if (command === 'generate') {
  await mkdir(out, { recursive: true });
  const world = generateWorld({ tier, seed });

  await writeFile(join(out, 'world.json'), json(world) + '\n', { flag: 'wx' });
  await writeDatabases(world, out);
  console.log(
    json({
      out,
      clients: world.clients.length,
      campaigns: world.campaigns.length,
      ads: world.ads.length,
    }),
  );
  process.exit(0);
}

if (command !== 'validate' && command !== 'run')
  throw new Error('Unknown command');

if (!['pilot', 'main', 'scale'].includes(values.stage!))
  throw new Error('Unknown stage');

const selectedArms =
  values.arm === 'all'
    ? arms
    : ([
        z.enum(['baseline-tools', 'baseline-code', 'relate']).parse(values.arm),
      ] as Arm[]);
const pattern = values.task
  ? new RegExp(
      '^' +
        values.task
          .split('*')
          .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    )
  : undefined;
const tasks = catalogue.filter((t) =>
  pattern ? pattern.test(t.id) : values.stage === 'pilot' ? t.pilot : true,
);

if (!tasks.length) throw new Error('No matching tasks');

const model =
  command === 'run'
    ? anthropicModel(values.model ?? '', process.env.ANTHROPIC_API_KEY ?? '')
    : undefined;

if (command === 'run' && !values.model)
  throw new Error('Pass an explicit --model identifier');

const price: Price | undefined = values.pricing
  ? z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
      })
      .strict()
      .parse(JSON.parse(await readFile(values.pricing, 'utf8')))
  : undefined;
const config: RunConfig = {
  tier,
  seed,
  arms: selectedArms,
  model: model?.name ?? 'reference',
  k,
  tasks: tasks.map((t) => t.id),
  mode: model ? 'model' : 'reference',
  ...(price ? { price } : {}),
};
const manifest = await prepareRun(out, config);
let failures = 0;

for (const task of tasks)
  for (let repeat = 0; repeat < k; repeat++)
    for (const arm of selectedArms) {
      const r = await runOne({
        task,
        arm,
        tier,
        seed,
        repeat,
        out,
        manifestId: manifest.id,
        ...(model ? { model } : {}),
        ...(price ? { price } : {}),
      });

      console.log(
        json({
          task: task.id,
          arm,
          repeat,
          status: r.status,
          passed: r.passed,
          mistakes: r.mistakes,
          error: typeof r.error === 'string' ? r.error.slice(0, 500) : r.error,
        }),
      );

      if (r.status !== 'deferred' && !r.passed) failures++;
    }

if ((await currentManifest(config)).revision !== manifest.revision) {
  await writeFile(
    join(out, 'invalidated.json'),
    json({ reason: 'Source changed during execution' }) + '\n',
  );
  throw new Error(
    'Source changed during execution; run retained but invalidated.',
  );
}

console.log(json({ out, manifest: manifest.id, failures }));

if (failures) process.exitCode = 1;
