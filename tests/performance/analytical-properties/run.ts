import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { availableParallelism, cpus, platform, arch, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openObjects } from './model.js';
import type { Row, Values } from './model.js';
import {
  customers,
  events,
  summarizedEvents,
  workloadVersion,
} from './seed.js';
import {
  createAdapter,
  mockedStages,
  unavailableMeasurements,
} from './adapter.js';
import { openReference } from './reference.js';
import { scenarios } from './scenarios.js';
import type { Scenario } from './scenarios.js';
import { Trace } from './timing.js';
import { markdown, summarizeSamples } from './report.js';
import type { Sample } from './report.js';

export interface Config {
  customers: number;
  events: number;
  seed: number;
  repetitions: number;
  warmups: number;
}

export const profiles: Record<'small' | 'full', Config[]> = {
  small: [
    { customers: 100, events: 1000, seed: 42, repetitions: 3, warmups: 1 },
  ],
  full: [100, 1000, 10000].flatMap((count) =>
    [100000, 1000000].map((eventCount) => ({
      customers: count,
      events: eventCount,
      seed: 42,
      repetitions: 30,
      warmups: 3,
    })),
  ),
};

/** One scenario, with an oracle that can only originate in SQLite. */
export async function measureScenario(
  scenario: Scenario,
  config: Pick<Config, 'warmups' | 'repetitions'>,
  referenceQuery: () => Row[] | Promise<Row[]>,
  hybridQuery: (trace: Trace) => Promise<Row[]>,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  let expected: Row[] | undefined;

  for (const mode of ['sqlite-reference', 'hybrid-mock'] as const) {
    const execute = async (phase: Sample['phase']) => {
      const trace = new Trace();
      const start = performance.now();
      let error: string | undefined;
      let durationMs: number | undefined;

      try {
        if (mode === 'hybrid-mock' && expected === undefined)
          throw new Error(
            'SQLite oracle unavailable; hybrid result cannot be validated',
          );

        const rows =
          mode === 'hybrid-mock'
            ? await trace.measure('request', 'real', () => hybridQuery(trace))
            : await trace.measure('sqlite-round-trip', 'real', referenceQuery);

        durationMs = performance.now() - start;

        // Only SQLite can establish the oracle. Validation is outside timing.
        if (expected !== undefined) assert.deepEqual(rows, expected);
        else if (mode === 'sqlite-reference') expected = structuredClone(rows);

        if (mode === 'sqlite-reference') {
          trace.counters.statements = 1;
          trace.counters.objectsReturned = rows.length;
        }
      } catch (cause) {
        durationMs ??= performance.now() - start;
        error = cause instanceof Error ? cause.message : String(cause);
      }

      samples.push({
        scenario,
        mode,
        phase,
        durationMs,
        spans: trace.spans,
        counters: trace.counters,
        status: error === undefined ? 'ok' : 'error',
        ...(error === undefined ? {} : { error }),
      });
    };

    await execute('first-of-scenario');

    for (let i = 0; i < config.warmups; i++) await execute('warmup');

    for (let i = 0; i < config.repetitions; i++) await execute('warm');
  }

  return samples;
}

export async function runWorkload(config: Config) {
  for (const [key, value] of Object.entries(config))
    assert(
      Number.isSafeInteger(value) &&
        value >= (key === 'warmups' || key === 'seed' ? 0 : 1),
      `Invalid ${key}`,
    );

  const started = performance.now();
  const records = customers(config.customers);
  const values = new Map<string, Values>();
  const objects = await openObjects(records);
  let reference: ReturnType<typeof openReference> | undefined;

  try {
    reference = openReference(
      records,
      objects.ids,
      summarizedEvents(
        events(config.customers, config.events, config.seed),
        values,
      ),
    );
    const adapter = createAdapter(objects, values);
    const setupMs = performance.now() - started;
    const samples: Sample[] = [];

    for (const scenario of Object.keys(scenarios) as Scenario[])
      samples.push(
        ...(await measureScenario(
          scenario,
          config,
          () => reference!.query(scenario),
          (trace) => adapter.query(scenarios[scenario], trace),
        )),
      );

    return {
      config,
      setupMs,
      sqliteVersion: reference.version,
      samples,
      summary: summarizeSamples(samples),
    };
  } finally {
    try {
      reference?.close();
    } finally {
      await objects.app.close();
    }
  }
}

export function gitMetadata(cwd = process.cwd(), executable = 'git') {
  try {
    const git = (args: string[]) =>
      execFileSync(executable, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();

    return {
      commit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain']).length > 0,
    };
  } catch {
    return { commit: null, dirty: null };
  }
}

/** Checkpoint completed workloads before starting the next; preserve setup failures. */
export async function runProfile(
  configs: Config[],
  output: string,
  metadata: Record<string, unknown>,
  run = runWorkload,
) {
  const workloads: (
    | Awaited<ReturnType<typeof runWorkload>>
    | { config: Config; samples: Sample[]; error: string }
  )[] = [];

  await mkdir(output, { recursive: true });
  const checkpoint = async () => {
    for (const [name, content] of [
      ['results.json', JSON.stringify({ metadata, workloads }, null, 2) + '\n'],
      ['report.md', markdown(workloads)],
    ]) {
      const path = resolve(output, name!);

      await writeFile(path + '.tmp', content!);
      await rename(path + '.tmp', path);
    }
  };

  await checkpoint();

  for (const config of configs) {
    console.log(
      `Running ${config.customers} customers / ${config.events} events`,
    );

    try {
      workloads.push(await run(config));
    } catch (cause) {
      workloads.push({
        config,
        samples: [],
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }

    await checkpoint();
  }

  return {
    workloads,
    failed: workloads.some(
      (w) => 'error' in w || w.samples.some((s) => s.status === 'error'),
    ),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'small' },
      out: { type: 'string', default: 'benchmark-results/analytical' },
    },
  });

  assert(
    values.profile === 'small' || values.profile === 'full',
    'profile must be small or full',
  );
  const output = resolve(values.out);
  const metadata = {
    schemaVersion: 2,
    workloadVersion,
    startedAt: new Date().toISOString(),
    ...gitMetadata(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    memoryBytes: totalmem(),
    profile: values.profile,
    concurrency: 1,
    objectStore: 'Relate memory store',
    source: 'synthetic mock connector',
    analyticalAdapter: 'mock precomputed values',
    reference:
      'SQLite :memory:; index(customer,type,at); ANALYZE; synchronous driver; no network/pool',
    mockedStages,
    unavailableMeasurements,
    performanceComparisonEligible: false,
  };
  const result = await runProfile(profiles[values.profile], output, metadata);

  console.log(`Results: ${output}`);

  if (result.failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
