import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(callback);
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'relate-package-check-'));
const packages = ['protocol', 'relate', 'runtime', 'postgres'];

try {
  const tarballs = join(temp, 'tarballs');

  await mkdir(tarballs);
  const dependencies = { zod: '4.6.5' };

  for (const name of packages) {
    const directory = resolve(root, 'packages', name);
    const metadata = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );

    await execFile('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: directory,
    });
    dependencies[metadata.name] =
      `file:${join(tarballs, `${metadata.name.replace('@', '').replace('/', '-')}-${metadata.version}.tgz`)}`;
  }

  const consumer = join(temp, 'consumer');

  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies }),
  );
  await execFile(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: consumer },
  );
  const program = `
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineAccess, defineGraph, defineObject, defineSource, source, objectId, from } from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime, createMemoryStore } from '@relate/runtime';
import { createPostgresStore } from '@relate/postgres';
import { ReadError } from '@relate/protocol';
const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: { organization: z.string() } });
const crm = defineSource({ id: 'crm', idField: 'id', schema: z.object({ id: z.string(), name: z.string() }) });
const Customer = defineObject({ id: 'customer', name: 'Customer', membership: source(crm), properties: {
  id: objectId({ id: 'customer.id', access: access.groups.ordinary }),
  name: from(crm.fields.name, { id: 'customer.name', access: access.groups.ordinary }),
} });
const model = compile(defineGraph({ id: 'graph', objects: [Customer], access, policies: [] }));
assert.equal(model.manifest.objects[0].id, 'customer');
assert.equal(typeof createRuntime, 'function');
assert.equal(createMemoryStore().durability, 'volatile');
const memoryModel = compile(defineGraph({ id: 'graph', objects: [Customer], access, policies: [access.policy(Customer, { read: { gate: access.role('reader'), evidenceMaxAgeMs: 30000 } })] }));
const runtime = createRuntime({ model: memoryModel, graphId: 'smoke', sources: { crm: { connectionId: 'fixture', authorization: 'shared-service', connector: { async fetch(id) { return { state: 'present', record: { id, name: 'Ada' } }; } } } } });
const objectIdValue = await runtime.adopt('customer', '1');
const read = await runtime.read({ id: 'reader', roles: ['reader'], claims: {} }, 'customer', objectIdValue);
assert.equal(read.data.name, 'Ada');
assert.equal(read.meta.fields.name.retentionDurability, 'volatile');
const store = createPostgresStore({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' });
await store.close();
assert.equal(new ReadError('incomplete').code, 'incomplete');
assert.equal((await import('relate/model')).validateManifest(model.manifest).graphDefinitionId, 'graph');
assert.equal(typeof (await import('@relate/runtime/storage')).compareObservation, 'function');
await assert.rejects(import('relate/dist/compiler.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('Installed tarballs load and compile through plain Node ESM.');
`;

  await writeFile(join(consumer, 'smoke.mjs'), program);
  const result = await execFile(process.execPath, ['smoke.mjs'], {
    cwd: consumer,
  });

  process.stdout.write(result.stdout);
  await writeFile(
    join(consumer, 'types.ts'),
    `
import { z } from 'zod';
import { defineAccess, defineSource, defineObject, objectId, source, from } from 'relate';
import type { ReadResult } from '@relate/protocol';
import type { ObservationStore } from '@relate/runtime/storage';
import type { RuntimeOptions } from '@relate/runtime';
const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: { organization: z.string() } });
const crm = defineSource({ id: 'crm', idField: 'id', schema: z.object({ id: z.string(), name: z.string() }) });
from(crm.fields.name, { id: 'customer.name', access: access.groups.ordinary });
// @ts-expect-error source references preserve field names
crm.fields.missing;
// @ts-expect-error every field requires explicit classification
from(crm.fields.name, { id: 'customer.name' });
const identity = objectId({ id: 'customer.identity', access: access.groups.ordinary });
const idValue: string = identity.schema.parse('generated');
// @ts-expect-error Relate owns the ID validator
objectId(z.string(), { id: 'customer.identity', access: access.groups.ordinary });
// @ts-expect-error objects infer identity from objectId(), not a key selector
defineObject({ id: 'customer', name: 'Customer', key: 'id', membership: source(crm), properties: { id: identity } });
export type Contracts = [ReadResult, ObservationStore, RuntimeOptions];
`,
  );
  await writeFile(
    join(consumer, 'authorization.types.ts'),
    await readFile(
      resolve(root, 'packages/relate/test/authorization.types.ts'),
      'utf8',
    ),
  );
  await execFile(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'types.ts',
      'authorization.types.ts',
    ],
    { cwd: consumer },
  );
  console.log('Installed NodeNext consumer types pass.');
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);

  if (error.stderr) process.stderr.write(error.stderr);

  throw error;
} finally {
  await rm(temp, { recursive: true, force: true });
}
