import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { availableParallelism, cpus, platform, arch, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openObjects } from './model.js';
import type { Row } from './model.js';
import { randomUUID } from 'node:crypto';
import { openBackend, openStore } from './backend.js';
import { customers, events, workloadVersion } from './seed.js';
import { createAdapter, unavailableMeasurements } from './adapter.js';
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
  backend?: 'sqlite' | 'postgres';
  objectStore?: 'memory' | 'postgres';
  capture?: 'enabled' | 'disabled';
  freshness?: 'cached' | 'refresh';
  sourceDelayMs?: number;
}

export const profiles: Record<'small' | 'capacity' | 'full', Config[]> = {
  small: [
    { customers: 100, events: 1000, seed: 42, repetitions: 3, warmups: 1 },
  ],
  capacity: [1250, 12500].flatMap((count) =>
    [100000, 1000000].map((eventCount) => ({
      customers: count,
      events: eventCount,
      seed: 42,
      repetitions: 3,
      warmups: 1,
    })),
  ),
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
  relateQuery: (trace: Trace) => Promise<Row[]>,
): Promise<Sample[]> {
  const samples: Sample[] = [];
  let expected: Row[] | undefined;

  for (const mode of ['sqlite-reference', 'relate'] as const) {
    const execute = async (phase: Sample['phase']) => {
      const trace = new Trace();
      const start = performance.now();
      let error: string | undefined;
      let durationMs: number | undefined;

      try {
        if (mode === 'relate' && expected === undefined)
          throw new Error(
            'SQLite oracle unavailable; Relate result cannot be validated',
          );

        const rows =
          mode === 'relate'
            ? await trace.measure('request', 'real', () => relateQuery(trace))
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

      // Record delivery and result checking do not inflate request latency.
      try {
        await trace.settle();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      samples.push({
        scenario,
        mode,
        phase,
        durationMs,
        spans: trace.spans,
        counters: trace.counters,
        stages: trace.stages,
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

export async function runWorkload(input: Config) {
  const config = {
    backend: 'sqlite' as const,
    objectStore: 'memory' as const,
    capture: 'enabled' as const,
    freshness: 'cached' as const,
    sourceDelayMs: 0,
    ...input,
  };

  for (const key of [
    'customers',
    'events',
    'seed',
    'repetitions',
    'warmups',
    'sourceDelayMs',
  ] as const) {
    const value = config[key];

    assert(
      Number.isSafeInteger(value) &&
        value >= (['warmups', 'seed', 'sourceDelayMs'].includes(key) ? 0 : 1),
      `Invalid ${key}`,
    );
  }

  const started = performance.now();
  const records = customers(config.customers);
  const backend = await openBackend(
    config.backend,
    events(config.customers, config.events, config.seed),
  );
  let backing: Awaited<ReturnType<typeof openStore>> | undefined;
  let objects: Awaited<ReturnType<typeof openObjects>> | undefined;
  let reference: ReturnType<typeof openReference> | undefined;

  try {
    const graphId = `analytical-benchmark-${randomUUID()}`;

    backing = await openStore(config.objectStore, graphId);
    objects = await openObjects(records, {
      ...config,
      graphId,
      store: backing.store,
      resource: backend.resource,
    });
    reference = openReference(
      records,
      objects.ids,
      events(config.customers, config.events, config.seed),
    );
    const adapter = createAdapter(objects);
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
      backendVersion: backend.version,
      sqliteVersion: reference.version,
      samples,
      summary: summarizeSamples(samples),
    };
  } finally {
    try {
      reference?.close();
    } finally {
      try {
        await objects?.app.close();
      } finally {
        try {
          await backing?.close();
        } finally {
          await backend.close();
        }
      }
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
      `Running ${config.customers} customers / ${config.events} events (${config.backend ?? 'sqlite'}, ${config.objectStore ?? 'memory'}, capture ${config.capture ?? 'enabled'}, ${config.freshness ?? 'cached'})`,
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
      backend: { type: 'string', default: 'sqlite' },
      store: { type: 'string', default: 'memory' },
      capture: { type: 'string', default: 'both' },
      freshness: { type: 'string', default: 'cached' },
      'source-delay-ms': { type: 'string', default: '0' },
      customers: { type: 'string' },
      events: { type: 'string' },
    },
  });

  assert(
    values.profile === 'small' ||
      values.profile === 'capacity' ||
      values.profile === 'full',
    'profile must be small, capacity or full',
  );
  assert(
    ['sqlite', 'postgres', 'both'].includes(values.backend),
    'backend must be sqlite, postgres or both',
  );
  assert(
    ['memory', 'postgres'].includes(values.store),
    'store must be memory or postgres',
  );
  assert(
    ['enabled', 'disabled', 'both'].includes(values.capture),
    'capture must be enabled, disabled or both',
  );
  assert(
    ['cached', 'refresh'].includes(values.freshness),
    'freshness must be cached or refresh',
  );
  const output = resolve(values.out);
  const metadata = {
    schemaVersion: 3,
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
    objectStore: values.store,
    source: 'synthetic connector with configured delay on refresh',
    sourceDelayMs: Number(values['source-delay-ms']),
    analyticalAdapter:
      'public Node-host query pages with real dataset connector',
    ranking:
      'one runtime scope-first orderBy query with full-scope and selected-page revalidation',
    reference:
      'SQLite :memory:; index(customer,type,at); ANALYZE; synchronous driver; no network/pool',
    unavailableMeasurements,
    performanceComparisonEligible: false,
  };
  const backends =
    values.backend === 'both'
      ? (['sqlite', 'postgres'] as const)
      : [values.backend as 'sqlite' | 'postgres'];
  const captures =
    values.capture === 'both'
      ? (['disabled', 'enabled'] as const)
      : [values.capture as 'enabled' | 'disabled'];
  const selected = profiles[values.profile].filter(
    (config) =>
      (values.customers === undefined ||
        config.customers === Number(values.customers)) &&
      (values.events === undefined || config.events === Number(values.events)),
  );

  assert(
    selected.length > 0,
    'No profile workloads match the customer/event filters',
  );
  const configs = selected.flatMap((config) =>
    backends.flatMap((backend) =>
      captures.map((capture): Config => ({
        ...config,
        backend,
        capture,
        objectStore: values.store as 'memory' | 'postgres',
        freshness: values.freshness as 'cached' | 'refresh',
        sourceDelayMs: Number(values['source-delay-ms']),
      })),
    ),
  );
  const result = await runProfile(configs, output, metadata);

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
