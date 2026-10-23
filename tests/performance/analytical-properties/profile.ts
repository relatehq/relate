// Untimed diagnostic, run separately from run.ts so sampling never biases latency samples.
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { gitMetadata, openWorkload, resolveConfig } from './run.js';
import { scenarios } from './scenarios.js';
import type { Scenario } from './scenarios.js';
import { Trace } from './timing.js';

interface Frame {
  functionName: string;
  url: string;
  lineNumber: number;
  selfMs: number;
}

/** Self time per call frame, and per owning package or file, largest first. */
export function summarizeProfile(profile: Profiler.Profile, root: string) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<number, number>();

  profile.samples?.forEach((id, i) =>
    self.set(id, (self.get(id) ?? 0) + profile.timeDeltas![i]! / 1000),
  );

  const frames = new Map<string, Frame>();

  for (const [id, ms] of self) {
    const { functionName, url, lineNumber } = byId.get(id)!.callFrame;
    const frame = {
      functionName: functionName || '(anonymous)',
      url: url.replace(root, '<repo>'),
      lineNumber: lineNumber + 1,
    };
    const key = JSON.stringify(frame);

    frames.set(key, {
      ...frame,
      selfMs: (frames.get(key)?.selfMs ?? 0) + ms,
    });
  }

  const owners = new Map<string, number>();

  for (const frame of frames.values()) {
    const owner =
      /<repo>\/(packages|connectors)\/([^/]+)\/(?:dist|src)\/(.+)$/
        .exec(frame.url)
        ?.slice(2)
        .join('/') ??
      (frame.url.includes('node_modules')
        ? 'node_modules'
        : frame.url
          ? frame.url.startsWith('node:')
            ? 'node internals'
            : frame.url
          : frame.functionName);

    owners.set(owner, (owners.get(owner) ?? 0) + frame.selfMs);
  }

  const byMs = <T extends { selfMs: number }>(a: T, b: T) =>
    b.selfMs - a.selfMs;

  return {
    sampledMs: [...self.values()].reduce((a, b) => a + b, 0),
    frames: [...frames.values()].sort(byMs).slice(0, 40),
    owners: [...owners]
      .map(([owner, selfMs]) => ({ owner, selfMs }))
      .sort(byMs)
      .slice(0, 25),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'benchmark-results/profile' },
      backend: { type: 'string', default: 'postgres' },
      store: { type: 'string', default: 'memory' },
      scenario: { type: 'string', default: 'ranking' },
      customers: { type: 'string', default: '12500' },
      events: { type: 'string', default: '1000000' },
    },
  });

  assert(['sqlite', 'postgres', 'duckdb'].includes(values.backend));
  assert(['memory', 'postgres'].includes(values.store));
  assert(Object.hasOwn(scenarios, values.scenario), 'Unknown scenario');
  const scenario = values.scenario as Scenario;
  const config = resolveConfig({
    customers: Number(values.customers),
    events: Number(values.events),
    seed: 42,
    repetitions: 1,
    warmups: 1,
    backend: values.backend as 'sqlite' | 'postgres' | 'duckdb',
    objectStore: values.store as 'memory' | 'postgres',
    capture: 'disabled',
  });
  const output = resolve(values.out);
  const workload = await openWorkload(config);
  const session = new Session();

  await mkdir(output, { recursive: true });

  try {
    const expected = workload.reference.query(scenario);
    const request = async () => {
      const trace = new Trace();
      const rows = await workload.adapter.query(scenarios[scenario], trace);

      await trace.settle();
      assert.deepEqual(rows, expected);

      return trace;
    };

    await request();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 500 });
    await session.post('Profiler.start');
    const start = performance.now();
    const trace = await request();
    const elapsedMs = performance.now() - start;
    const { profile } = await session.post('Profiler.stop');
    const summary = {
      ...gitMetadata(),
      node: process.version,
      config,
      scenario,
      elapsedMs,
      counters: trace.counters,
      ...summarizeProfile(profile, process.cwd()),
      note: 'One profiled warm request after a validated warmup. Sampling adds overhead: never compare elapsedMs with run.ts samples. Node CPU only; database work is outside the profile. Frame lines refer to built JavaScript.',
    };

    await writeFile(
      resolve(output, 'profile.cpuprofile.gz'),
      gzipSync(JSON.stringify(profile)),
    );
    await writeFile(
      resolve(output, 'summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        {
          elapsedMs: summary.elapsedMs,
          sampledMs: summary.sampledMs,
          counters: summary.counters,
          owners: summary.owners.slice(0, 12),
          frames: summary.frames.slice(0, 12),
        },
        null,
        2,
      ),
    );
    console.log(`Profile: ${output}`);
  } finally {
    session.disconnect();
    await workload.close();
  }
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
