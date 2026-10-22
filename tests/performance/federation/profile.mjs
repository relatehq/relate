// Untimed diagnostic, run separately from the comparison to avoid profiler bias.
import assert from 'node:assert/strict';
import { Session } from 'node:inspector/promises';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createMemoryStore } from '@relate/runtime';
import { openFixture } from './fixture.mjs';
import { openTransport } from './transports.mjs';
import { openRelate } from './relate-adapter.mjs';
import { normalize } from './queries.mjs';

const out = process.argv[2] ?? 'benchmark-results/federation-scope-profile';

await mkdir(out, { recursive: true });
const fixture = await openFixture(12500, 1000000);
let engine, host;
const session = new Session();
const counts = {};
let counting = false;
const underlying = createMemoryStore();
const store = { ...underlying };

for (const name of ['load', 'scan', 'resolve', 'beginFetch', 'accept']) {
  store[name] = (...args) => {
    if (counting) counts[name] = (counts[name] ?? 0) + 1;

    return underlying[name](...args);
  };
}

try {
  engine = await openTransport('child', fixture.config);
  let execution;

  host = await openRelate(fixture, engine, store, {
    scope: true,
    onExecution: (value) => {
      execution = value;
    },
  });
  assert.deepEqual(normalize((await host.query()).rows), host.expected);
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 1000 });
  await session.post('Profiler.start');
  counting = true;
  const start = performance.now();
  const result = await host.query();
  const elapsedMs = performance.now() - start;

  counting = false;
  const { profile } = await session.post('Profiler.stop');

  assert.deepEqual(normalize(result.rows), host.expected);
  const root = process.cwd();

  for (const node of profile.nodes)
    node.callFrame.url = node.callFrame.url.replace(root, '<repo>');

  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const times = new Map();

  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];

    times.set(id, (times.get(id) ?? 0) + profile.timeDeltas[i] / 1000);
  }

  const top = [...times.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([id, selfMs]) => ({
      ...byId.get(id).callFrame,
      lineNumber: byId.get(id).callFrame.lineNumber + 1,
      selfMs,
    }));

  await writeFile(`${out}/profile.cpuprofile`, JSON.stringify(profile));
  const { sql, plan, ...scope } = execution;

  await writeFile(
    `${out}/summary.json`,
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        fixture: fixture.provenance,
        node: process.version,
        elapsedMs,
        scope,
        counts,
        top,
        note: 'One separate profiled warm request. Sampling and counters add overhead; never mix this duration with primary benchmark samples. Node CPU only; the child engine and PostgreSQL are outside this profile. Frame lines refer to built JS, not TypeScript source.',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ elapsedMs, counts, top: top.slice(0, 10) }, null, 2),
  );
} finally {
  session.disconnect();
  await host?.close();
  await engine?.close();
  await fixture.close();
}
