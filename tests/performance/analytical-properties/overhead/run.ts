import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { availableParallelism, cpus, platform } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openBackend, openStore } from '../backend.js';
import { openObjects } from '../model.js';
import { customers, events, workloadVersion } from '../seed.js';
import { createAdapter } from '../adapter.js';
import { openReference } from '../reference.js';
import { scenarios } from '../scenarios.js';
import { Trace } from '../timing.js';
import { gitMetadata } from '../run.js';
import { percentile } from '../report.js';
import { observeResource, concurrentMap, unionDuration } from './capture.js';
import type { Interval } from './capture.js';
import { postgresDatabase } from './database.js';
import { duckDatabase } from '../duckdb.js';
import type { Database, Scenario } from './database.js';

export const modes = [
  'direct-warm',
  'direct-fresh',
  'connector',
  'relate',
  'colocated',
  'materialized',
] as const;

export type Mode = (typeof modes)[number];

export interface Config {
  backend: 'postgres' | 'duckdb';
  customers: number;
  events: number;
  repetitions: number;
  warmups: number;
  objectStore: 'memory' | 'postgres';
  freshness: 'cached' | 'refresh';
  sourceDelayMs: number;
}

export interface Sample {
  scenario: Scenario;
  mode: Mode;
  phase: 'first-of-scenario' | 'warmup' | 'warm';
  block: number;
  order: number;
  durationMs: number;
  status: 'ok' | 'error';
  error?: string;
  connectorBusyMs?: number;
  outsideConnectorMs?: number;
  intervals?: Interval[];
  counters?: Record<string, number>;
  stages?: Trace['stages'];
}

export function modeOrder(block: number): Mode[] {
  const offset = block % modes.length;
  const order = [...modes.slice(offset), ...modes.slice(0, offset)];

  return Math.floor(block / modes.length) % 2 ? order.reverse() : order;
}

export function summarize(samples: Sample[]) {
  return (['enrichment', 'ranking'] as const).flatMap((scenario) =>
    modes.map((mode) => {
      const selected = samples.filter(
        (s) => s.scenario === scenario && s.mode === mode && s.phase === 'warm',
      );
      const values = selected
        .filter((s) => s.status === 'ok')
        .map((s) => s.durationMs);

      return {
        scenario,
        mode,
        samples: selected.length,
        failures: selected.length - values.length,
        medianMs: percentile(values, 0.5),
        p95Ms: values.length >= 20 ? percentile(values, 0.95) : null,
      };
    }),
  );
}

/** Subtract matched block observations, not independently selected medians. */
export function differences(samples: Sample[]) {
  const pairs: [Mode, Mode][] = [
    ['connector', 'direct-warm'],
    ['connector', 'direct-fresh'],
    ['relate', 'connector'],
    ['relate', 'direct-warm'],
    ['relate', 'colocated'],
  ];

  return (['enrichment', 'ranking'] as const).flatMap((scenario) =>
    pairs.map(([a, b]) => {
      const left = samples.filter(
        (s) => s.scenario === scenario && s.mode === a && s.phase === 'warm',
      );
      const values = left.flatMap((s) => {
        const other = samples.find(
          (r) =>
            r.scenario === scenario &&
            r.mode === b &&
            r.phase === 'warm' &&
            r.block === s.block,
        );

        return s.status === 'ok' && other?.status === 'ok'
          ? [s.durationMs - other.durationMs]
          : [];
      });

      return {
        scenario,
        comparison: `${a} minus ${b}`,
        pairs: values.length,
        excluded: left.length - values.length,
        medianDifferenceMs: percentile(values, 0.5),
        minDifferenceMs: values.length ? Math.min(...values) : null,
        maxDifferenceMs: values.length ? Math.max(...values) : null,
      };
    }),
  );
}

export async function runOverhead(
  config: Config,
  checkpoint: (result: object) => Promise<void> = async () => {},
) {
  const records = customers(config.customers);
  const backend = await openBackend(
    config.backend,
    events(config.customers, config.events, 42),
  );
  const observer = observeResource(backend.resource);
  let backing: Awaited<ReturnType<typeof openStore>> | undefined;
  let objects: Awaited<ReturnType<typeof openObjects>> | undefined;
  let reference: ReturnType<typeof openReference> | undefined;
  let database: Database | undefined;
  const samples: Sample[] = [];
  const captures: object[] = [];
  const result = () => ({
    config,
    backendVersion: backend.version,
    samples,
    captures,
    materializeMs: database?.materializeMs,
    alternativeSql: database?.sql,
    summary: summarize(samples),
    differences: differences(samples),
  });

  try {
    const graphId = `analytical-benchmark-${randomUUID()}`;

    backing = await openStore(config.objectStore, graphId);
    const store = backing.store;

    objects = await observer.initialize(() =>
      openObjects(records, {
        ...config,
        graphId,
        store,
        resource: observer.resource,
        capture: 'enabled',
      }),
    );
    reference = openReference(
      records,
      objects.ids,
      events(config.customers, config.events, 42),
    );

    if (config.backend === 'duckdb') {
      database = await duckDatabase(backend.file!, records, objects.ids);
    } else {
      const [schema] = JSON.parse(backend.resource.resourceId) as [
        string,
        string,
      ];

      database = await postgresDatabase(schema, records, objects.ids);
    }

    const adapter = createAdapter(objects);

    for (const scenario of ['enrichment', 'ranking'] as const) {
      const expected = reference.query(scenario);
      const trace = new Trace();
      const captured = await observer.capture(async () => {
        try {
          return await adapter.query(scenarios[scenario], trace);
        } finally {
          await trace.settle();
        }
      });

      assert.deepEqual(captured.result, expected);
      const statements = captured.statements;

      assert.equal(
        statements.length,
        scenario === 'enrichment'
          ? 1
          : Math.ceil((config.customers * 0.8) / 1000),
      );
      captures.push({
        scenario,
        statements: statements.map((s) => ({
          sql: s.sql,
          parameters: s.parameters,
          slots: s.query.slots,
          aggregateTypes: s.query.aggregates.map((a) => a.result),
          rawRows: s.rawRows,
          sqlHash: createHash('sha256').update(s.sql!).digest('hex'),
        })),
      });

      for (
        let block = 0;
        block < 1 + config.warmups + config.repetitions;
        block++
      ) {
        const phase =
          block === 0
            ? 'first-of-scenario'
            : block <= config.warmups
              ? 'warmup'
              : 'warm';

        for (const [order, mode] of modeOrder(block).entries()) {
          const active = new Trace();
          const intervals: Interval[] = [];

          if (mode === 'relate') observer.intervals(intervals);

          const start = performance.now();
          let durationMs: number | undefined;
          let error: string | undefined;

          try {
            let value: unknown;

            if (mode === 'relate')
              value = await adapter.query(scenarios[scenario], active);
            else if (mode === 'connector')
              value = await concurrentMap(
                statements,
                4,
                async (s) =>
                  (
                    await backend.resource.connection.analytics.execute(
                      s.plan,
                      { signal: new AbortController().signal, timeoutMs: 5000 },
                    )
                  ).rows,
              );
            else if (mode === 'direct-warm' || mode === 'direct-fresh')
              value = await database.replay(
                statements,
                mode === 'direct-fresh',
              );
            else
              value = await database.colocated(
                scenario,
                mode === 'materialized',
              );

            durationMs = performance.now() - start;

            if (mode === 'connector')
              assert.deepEqual(
                value,
                statements.map((s) => s.rows),
              );
            else if (mode.startsWith('direct-'))
              assert.deepEqual(
                value,
                statements.map((s) => s.rawRows),
              );
            else assert.deepEqual(value, expected);
          } catch (cause) {
            durationMs ??= performance.now() - start;
            error = cause instanceof Error ? cause.message : String(cause);
          } finally {
            observer.intervals(undefined);

            try {
              await active.settle();
            } catch (cause) {
              error = String(cause);
            }
          }

          const busy = unionDuration(intervals);

          samples.push({
            scenario,
            mode,
            phase,
            block,
            order,
            durationMs: durationMs!,
            status: error ? 'error' : 'ok',
            ...(error ? { error } : {}),
            ...(mode === 'relate'
              ? {
                  connectorBusyMs: busy,
                  outsideConnectorMs: durationMs! - busy,
                  intervals: intervals.map((s) => ({
                    startMs: s.startMs - start,
                    endMs: s.endMs - start,
                  })),
                  counters: active.counters,
                  stages: active.stages,
                }
              : {}),
          });
        }

        await checkpoint(result());
      }
    }

    return result();
  } finally {
    reference?.close();

    try {
      await objects?.app.close();
    } finally {
      try {
        await database?.close();
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

async function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string', default: 'small' },
      backend: { type: 'string', default: 'postgres' },
      customers: { type: 'string' },
      events: { type: 'string' },
      repetitions: { type: 'string' },
      store: { type: 'string', default: 'memory' },
      freshness: { type: 'string', default: 'cached' },
      'source-delay-ms': { type: 'string', default: '0' },
      out: { type: 'string', default: 'benchmark-results/overhead' },
    },
  });

  assert(['small', 'full'].includes(values.profile));
  assert(['postgres', 'duckdb', 'both'].includes(values.backend));
  assert(['memory', 'postgres'].includes(values.store));
  assert(['cached', 'refresh'].includes(values.freshness));
  const populations = values.customers
    ? [Number(values.customers)]
    : values.profile === 'small'
      ? [100]
      : [1000, 12500];
  const eventCounts = values.events
    ? [Number(values.events)]
    : values.profile === 'small'
      ? [1000]
      : [100000, 1000000];
  const repetitions = Number(
    values.repetitions ?? (values.profile === 'small' ? 3 : 20),
  );
  const sourceDelayMs = Number(values['source-delay-ms']);

  for (const n of [...populations, ...eventCounts, repetitions])
    assert(Number.isSafeInteger(n) && n > 0);

  assert(Number.isSafeInteger(sourceDelayMs) && sourceDelayMs >= 0);
  const output = resolve(values.out);

  await mkdir(output, { recursive: true });
  const metadata = {
    schemaVersion: 1,
    workloadVersion,
    startedAt: new Date().toISOString(),
    ...gitMetadata(),
    node: process.version,
    cpu: cpus()[0]?.model,
    platform: platform(),
    availableParallelism: availableParallelism(),
    requestConcurrency: 1,
    statementConcurrency: 4,
    capture: 'enabled',
    seed: 42,
    modeOrder: 'cyclic rotation, reverse each group of six blocks',
    scope:
      'static exact-plan replay and alternative architectures; not equivalent security/freshness contracts',
  };
  const workloads: object[] = [];
  let failed = false;
  const persist = async (current?: object) => {
    const text =
      JSON.stringify(
        { metadata, workloads: [...workloads, ...(current ? [current] : [])] },
        (_key, value) =>
          typeof value === 'bigint' ? { $bigint: String(value) } : value,
        2,
      ) + '\n';

    await writeFile(`${output}/results.json.tmp`, text);
    await rename(`${output}/results.json.tmp`, `${output}/results.json`);
  };

  await persist();
  const backends =
    values.backend === 'both'
      ? (['postgres', 'duckdb'] as const)
      : [values.backend as Config['backend']];

  for (const backend of backends)
    for (const count of populations)
      for (const eventCount of eventCounts) {
        const config: Config = {
          backend,
          customers: count,
          events: eventCount,
          repetitions,
          warmups: 2,
          objectStore: values.store as Config['objectStore'],
          freshness: values.freshness as Config['freshness'],
          sourceDelayMs,
        };

        console.log(`Overhead: ${JSON.stringify(config)}`);

        let partial: object | undefined;

        try {
          const result = await runOverhead(config, async (current) => {
            partial = current;
            await persist(current);
          });

          workloads.push(result);
          failed ||= result.samples.some((s) => s.status === 'error');
        } catch (cause) {
          failed = true;
          workloads.push({
            ...partial,
            config,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }

        await persist();
      }

  console.log(`Results: ${output}`);

  if (failed) process.exitCode = 1;
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
