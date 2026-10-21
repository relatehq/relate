import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, platform, arch, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openObjects } from './model.js';
import { customers, events, summarize, workloadVersion } from './seed.js';
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

export async function runWorkload(config: Config) {
  for (const [key, value] of Object.entries(config))
    assert(
      Number.isSafeInteger(value) &&
        value >= (key === 'warmups' || key === 'seed' ? 0 : 1),
      `Invalid ${key}`,
    );

  const started = performance.now();
  const records = customers(config.customers);
  const values = summarize(
    events(config.customers, config.events, config.seed),
  );
  const objects = await openObjects(records);
  let reference: ReturnType<typeof openReference> | undefined;

  try {
    reference = openReference(
      records,
      objects.ids,
      events(config.customers, config.events, config.seed),
    );
    const adapter = createAdapter(objects, values);
    const setupMs = performance.now() - started;
    const samples: Sample[] = [];

    for (const scenario of Object.keys(scenarios) as Scenario[]) {
      let expected: ReturnType<typeof reference.query> | undefined;

      // Measure reference before using it as the oracle; seeding/ANALYZE are excluded.
      for (const mode of ['sqlite-reference', 'hybrid-mock'] as const) {
        const execute = async (phase: Sample['phase'], record: boolean) => {
          const trace = new Trace();
          const start = performance.now();
          let error: string | undefined;
          let durationMs: number | undefined;

          try {
            const rows =
              mode === 'hybrid-mock'
                ? await trace.measure('request', 'real', () =>
                    adapter.query(scenarios[scenario], trace),
                  )
                : await trace.measure('sqlite-round-trip', 'real', () =>
                    reference!.query(scenario),
                  );

            durationMs = performance.now() - start;

            // Validation is outside the measured request.
            if (expected) assert.deepEqual(rows, expected);
            else expected = rows;

            if (mode === 'sqlite-reference') {
              trace.counters.statements = 1;
              trace.counters.objectsReturned = rows.length;
            }
          } catch (cause) {
            durationMs ??= performance.now() - start;
            error = cause instanceof Error ? cause.message : String(cause);
          }

          const sample: Sample = {
            scenario,
            mode,
            phase,
            durationMs,
            spans: trace.spans,
            counters: trace.counters,
            status: error === undefined ? 'ok' : 'error',
            ...(error === undefined ? {} : { error }),
          };

          if (record || error !== undefined) samples.push(sample);
        };

        await execute('first-request', true);

        for (let i = 0; i < config.warmups; i++) await execute('warm', false);

        for (let i = 0; i < config.repetitions; i++)
          await execute('warm', true);
      }
    }

    return {
      config,
      setupMs,
      sqliteVersion: reference.version,
      samples,
      summary: summarizeSamples(samples),
    };
  } finally {
    reference?.close();
    await objects.app.close();
  }
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
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8' }).trim();
  const metadata = {
    schemaVersion: 1,
    workloadVersion,
    startedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
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
  const workloads = [];

  for (const config of profiles[values.profile]) {
    console.log(
      `Running ${config.customers} customers / ${config.events} events`,
    );
    workloads.push(await runWorkload(config));
  }

  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify({ metadata, workloads }, null, 2) + '\n',
  );
  await writeFile(
    resolve(output, 'report.md'),
    workloads
      .map(
        (w) =>
          `Workload: ${w.config.customers} customers / ${w.config.events} events\n\n${markdown(w.samples)}`,
      )
      .join('\n'),
  );
  console.log(`Results: ${output}`);

  if (workloads.some((w) => w.samples.some((s) => s.status === 'error')))
    process.exitCode = 1;
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
