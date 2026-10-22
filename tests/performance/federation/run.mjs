import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openFixture } from './fixture.mjs';
import { openTransport, binary } from './transports.mjs';
import { querySql, normalize } from './queries.mjs';
import { openRelate } from './relate-adapter.mjs';
import { createMemoryStore } from '@relate/runtime';

const { values: args } = parseArgs({
  options: {
    customers: { type: 'string', default: '100' },
    events: { type: 'string', default: '1000' },
    repetitions: { type: 'string', default: '24' },
    out: { type: 'string', default: 'benchmark-results/federation-small' },
    'skip-relate': { type: 'boolean', default: false },
    'skip-concurrency': { type: 'boolean', default: false },
  },
});
const customers = Number(args.customers),
  events = Number(args.events),
  repetitions = Number(args.repetitions);

for (const value of [customers, events, repetitions])
  assert(Number.isSafeInteger(value) && value > 0);

const out = resolve(args.out);

await mkdir(out, { recursive: true });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

async function sourceHashes(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const result = {};

  for (const entry of entries) {
    if (['target', 'measurements', 'engine.node'].includes(entry.name))
      continue;

    const file = `${path}/${entry.name}`;

    if (entry.isDirectory()) Object.assign(result, await sourceHashes(file));
    else result[file] = sha(await readFile(file));
  }

  return result;
}

const report = {
  metadata: {
    startedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain'])),
    node: process.version,
    rust: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim(),
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0].model,
    logicalCpus: cpus().length,
    totalMemory: totalmem(),
    sourceHashes: await sourceHashes('tests/performance/federation'),
    binarySha256: sha(await readFile(binary)),
    customers,
    events,
    repetitions,
    partitions: 4,
    runtimeThreads: 4,
    neonWorkerPool: process.env.UV_THREADPOOL_SIZE ?? 'default (4)',
    transport:
      'UTF-8 JSON, no compression, bounded final outputs; integer counts cast to strings',
  },
  startup: [],
  plans: [],
  samples: [],
  concurrency: [],
  failures: [],
};
const checkpoint = async () => {
  await writeFile(`${out}/results.json.tmp`, JSON.stringify(report, null, 2));
  await rename(`${out}/results.json.tmp`, `${out}/results.json`);
};

function rss(pid) {
  try {
    return (
      Number(
        execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
          encoding: 'utf8',
        }).trim(),
      ) * 1024
    );
  } catch {
    return null;
  }
}

const fixtureStart = performance.now();
let fixture;
const transports = [],
  publicPaths = [];

try {
  fixture = await openFixture(customers, events);
  report.fixture = {
    ...fixture.provenance,
    setupMs: performance.now() - fixtureStart,
  };

  for (const kind of ['neon', 'child', 'http']) {
    const transport = await openTransport(kind, fixture.config);

    transports.push(transport);
    report.startup.push({
      kind,
      ms: transport.startupMs,
      rssBytes: rss(transport.pid),
      note:
        kind === 'neon'
          ? 'includes first require and runtime creation; RSS includes Node and fixture'
          : 'fresh process, schema discovery and source pools; OS page cache uncontrolled',
    });
  }

  const snapshot = await transports[1].query('snapshot');

  report.snapshot = {
    ...snapshot,
    rssAfterBytes: rss(transports[1].pid),
    note: 'all four source tables; includes duplicated events in PG and Parquet, intentionally outside live query comparison',
  };
  const paths = [
    {
      name: 'native-js',
      run: (scenario) => fixture.native(scenario),
      pid: process.pid,
    },
  ];

  for (const transport of transports)
    for (const mode of ['scan', 'federated'])
      paths.push({
        name: `${transport.kind}-${mode}`,
        pid: transport.pid,
        run: (scenario) => transport.query({ mode, sql: querySql(scenario) }),
      });

  paths.push({
    name: 'child-snapshot',
    pid: transports[1].pid,
    run: (scenario) =>
      transports[1].query({ mode: 'federated', sql: querySql(scenario, true) }),
  });
  const validate = (value, expected, scenario) => {
    const rows = scenario === 'control' ? value.rows : normalize(value.rows);

    assert.deepEqual(rows, expected);

    return sha(JSON.stringify(rows));
  };

  const expectedByScenario = new Map();

  function expectedFor(scenario) {
    if (!expectedByScenario.has(scenario))
      expectedByScenario.set(scenario, fixture.expected(scenario));

    return expectedByScenario.get(scenario);
  }

  async function measure(path, scenario, phase, block) {
    const expected = path.expected ?? expectedFor(scenario);
    let maxLagMs = null,
      tick = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();

      maxLagMs = Math.max(maxLagMs ?? 0, now - tick - 2);
      tick = now;
    }, 2);
    const start = performance.now();
    let sample;

    try {
      const value = await path.run(scenario);
      const elapsedMs = performance.now() - start;

      clearInterval(timer);
      sample = {
        path: path.name,
        scenario,
        phase,
        block,
        elapsedMs,
        planMs: value.planMs,
        collectMs: value.collectMs,
        encodeMs: value.encodeMs,
        sourceRows: value.sourceRows,
        resultRows: value.rows.length,
        resultSha256: validate(value, expected, scenario),
        maxObservedTimerLagMs: maxLagMs,
        rssBytes: rss(path.pid),
        status: 'ok',
      };
    } catch (error) {
      clearInterval(timer);
      sample = {
        path: path.name,
        scenario,
        phase,
        block,
        status: 'error',
        error: error.message,
      };
      report.failures.push(sample);
      throw error;
    } finally {
      if (sample) report.samples.push(sample);

      await checkpoint();
    }
  }

  for (const scenario of [
    'control',
    'ranking-db',
    'ranking-file',
    'multi',
    'selective',
    'bulk',
  ]) {
    console.log(`Federation ${customers}/${events}: ${scenario}`);

    for (const mode of ['scan', 'federated']) {
      const response = await transports[1].query({
        mode,
        sql: querySql(scenario),
        explain: true,
      });

      validate(response, fixture.expected(scenario), scenario);
      // Generated fixture schema/path only, no credentials; make plans easy to diff.
      report.plans.push({
        scenario,
        mode,
        plan: response.plan
          .replaceAll(fixture.config.schema, '<fixture-schema>')
          .replaceAll(fixture.config.eventsPath, '<events.parquet>')
          .replaceAll(
            fixture.config.eventsPath.replace(/^\//, ''),
            '<events.parquet>',
          ),
      });
    }

    for (let block = -3; block < repetitions; block++) {
      const phase =
        block === -3 ? 'first-of-scenario' : block < 0 ? 'warmup' : 'warm';
      const offset = (block + 3) % paths.length;
      const order = [...paths.slice(offset), ...paths.slice(0, offset)];

      if (Math.floor((block + 3) / paths.length) % 2) order.reverse();

      for (const path of order) await measure(path, scenario, phase, block);
    }
  }

  if (!args['skip-relate']) {
    const store = createMemoryStore();

    for (const transport of [null, ...transports]) {
      const start = performance.now();
      const host = await openRelate(fixture, transport, store);

      publicPaths.push(host);
      const name = transport
        ? `relate-${transport.kind}-scan`
        : 'relate-postgres';

      report.startup.push({
        kind: name,
        ms: performance.now() - start,
        note: 'Relate adoption and host setup; excluded from request timing',
      });
      host.name = name;
      host.pid = process.pid;
      host.run = () => host.query();
    }

    for (let block = -3; block < repetitions; block++) {
      const offset = (block + 3) % publicPaths.length;

      for (const path of [
        ...publicPaths.slice(offset),
        ...publicPaths.slice(0, offset),
      ])
        await measure(
          path,
          'ranking-db',
          block === -3 ? 'first-of-scenario' : block < 0 ? 'warmup' : 'warm',
          block,
        );
    }
  }

  if (!args['skip-concurrency']) {
    for (const transport of transports)
      for (const mode of ['scan', 'federated']) {
        const expected = fixture.expected('multi');
        const start = performance.now();
        const latencies = [];

        // Five waves of four arrivals. IPC is a single serial worker by design.
        for (let wave = 0; wave < 5; wave++) {
          await Promise.all(
            Array.from({ length: 4 }, async () => {
              const start = performance.now();
              const result = await transport.query({
                mode,
                sql: querySql('multi'),
              });

              latencies.push(performance.now() - start);
              validate(result, expected, 'multi');
            }),
          );
        }

        const totalMs = performance.now() - start;

        report.concurrency.push({
          path: `${transport.kind}-${mode}`,
          arrivalsPerWave: 4,
          waves: 5,
          latencies,
          totalMs,
          requestsPerSecond: (20 * 1000) / totalMs,
        });
        await checkpoint();
      }
  }
} catch (error) {
  report.failures.push({ stage: 'run', error: error.message });
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const host of publicPaths) await host.close();

  for (const transport of transports) await transport.close();

  await fixture?.close();
  report.metadata.finishedAt = new Date().toISOString();
  await checkpoint();
}
