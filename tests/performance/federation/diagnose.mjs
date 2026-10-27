// Capture actual slot SQL and its physical source plan outside timed runs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { openFixture } from './fixture.mjs';
import { openTransport } from './transports.mjs';
import { openRelate } from './relate-adapter.mjs';
import { normalize } from './queries.mjs';

const out = process.argv[2] ?? 'benchmark-results/federation-diagnostic';

await mkdir(out, { recursive: true });
const fixture = await openFixture(12500, 1000000);
let engine, host;

try {
  engine = await openTransport('child', fixture.config);
  const requests = [];
  const tracked = {
    ...engine,
    async query(request) {
      requests.push(request);

      return engine.query(request);
    },
  };

  host = await openRelate(fixture, tracked);
  const result = await host.query();

  assert.deepEqual(normalize(result.rows), host.expected);
  const explained = await engine.query({ ...requests[0], explain: true });
  const redact = (text) =>
    text.replaceAll(fixture.config.schema, '<fixture-schema>');

  await writeFile(
    `${out}/diagnostic.json`,
    JSON.stringify(
      {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        fixture: fixture.provenance,
        mode: 'scan',
        batchCount: requests.length,
        sql: requests.map((request) => request.sql),
        firstBatchRows: explained.rows.length,
        firstBatchPlan: redact(explained.plan),
        expected: host.expected,
        note: 'Untimed follow-up evidence; fresh immutable fixture, same populations/seed, different adopted object IDs.',
      },
      null,
      2,
    ),
  );
} finally {
  await host?.close();
  await engine?.close();
  await fixture.close();
}
