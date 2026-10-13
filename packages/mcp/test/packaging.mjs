import assert from 'node:assert/strict';
import { execFile as callback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(callback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = await mkdtemp(join(tmpdir(), 'relate-mcp-package-'));

try {
  const tarballs = join(temporary, 'tarballs');

  await mkdir(tarballs);
  const dependencies = {};

  for (const name of ['protocol', 'relate', 'mcp']) {
    const cwd = join(root, 'packages', name);
    const metadata = JSON.parse(
      await readFile(join(cwd, 'package.json'), 'utf8'),
    );

    await execFile('pnpm', ['pack', '--pack-destination', tarballs], { cwd });
    dependencies[metadata.name] =
      `file:${join(tarballs, `${metadata.name.replace('@', '').replace('/', '-')}-${metadata.version}.tgz`)}`;
  }

  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies }),
  );
  await execFile(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: temporary },
  );
  // Standalone consumer program; no workspace or tutorial imports.
  await writeFile(
    join(temporary, 'smoke.mjs'),
    `
    import assert from 'node:assert/strict';
    import { createDevelopmentExecutor, createMcpServer, createStreamableHttpHandler, connectStdio } from '@relate/mcp';
    const revision = 'sha256:' + 'a'.repeat(64);
    const description = { formatVersion: 1, graphDefinitionId: 'packed', definitionRevision: revision, objects: {}, actions: {} };
    const operations = {
      discovery: { describe: () => ({ definitionId: 'packed', definitionRevision: revision, objects: {}, actions: {}, sdk: {} }), describeObject: () => undefined, describeAction: () => undefined },
      get: async () => { throw new Error('unused'); }, query: async () => { throw new Error('unused'); }, traverse: async () => { throw new Error('unused'); }, invoke: async () => { throw new Error('unused'); }, getReceipt: async () => { throw new Error('unused'); },
    };
    const executor = createDevelopmentExecutor();
    const graph = { description, operations };
    const result = await executor.execute({ graph, code: 'console.log("packed child"); return graph.describe().definitionId;' });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.equal(result.result, 'packed');
    assert.equal(result.logs[0].text, 'packed child\\n');
    assert.equal(typeof createStreamableHttpHandler, 'function');
    assert.equal(typeof connectStdio, 'function');
    const server = createMcpServer({ executor, bindGraph: () => graph });
    await server.close();
    console.log('MCP installed-tarball smoke passed');
  `,
  );
  const result = await execFile(process.execPath, ['smoke.mjs'], {
    cwd: temporary,
  });

  assert.match(result.stdout, /MCP installed-tarball smoke passed/);
  process.stdout.write(result.stdout);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
