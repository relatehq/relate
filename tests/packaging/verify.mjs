import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile as callback, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const execFile = promisify(callback);
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'relate-package-check-'));
const packages = [
  'packages/protocol',
  'packages/relate',
  'packages/runtime',
  'packages/postgres',
  'packages/node',
  'connectors/sqlite',
  'connectors/stripe',
  'connectors/salesforce',
  'apps/inspector',
  'packages/cli',
];

try {
  const tarballs = join(temp, 'tarballs');

  await mkdir(tarballs);
  const dependencies = { zod: '4.6.5' };

  for (const name of packages) {
    const directory = resolve(root, name);
    const metadata = JSON.parse(
      await readFile(join(directory, 'package.json'), 'utf8'),
    );

    // Workspace tarballs: `workspace:*` becomes the packed version.
    await execFile('pnpm', ['pack', '--pack-destination', tarballs], {
      cwd: directory,
    });
    dependencies[metadata.name] =
      `file:${join(tarballs, `${metadata.name.replace('@', '').replace('/', '-')}-${metadata.version}.tgz`)}`;
  }

  // App/connector authors can install and typecheck without the engine or host.
  const portable = join(temp, 'portable');

  await mkdir(portable);
  await writeFile(
    join(portable, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        relate: dependencies.relate,
        '@relate/protocol': dependencies['@relate/protocol'],
        zod: dependencies.zod,
      },
    }),
  );
  await execFile(
    'npm',
    [
      'install',
      '--engine-strict',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: portable,
    },
  );
  await writeFile(
    join(portable, 'app.types.ts'),
    await readFile(resolve(root, 'packages/relate/test/app.types.ts'), 'utf8'),
  );
  await execFile(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--outDir',
      'built',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'app.types.ts',
    ],
    { cwd: portable },
  );
  await writeFile(
    join(portable, 'smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { isAppDefinition } from 'relate';
import { SourceAccessDenied } from 'relate/connectors';
import { app } from './built/app.types.js';
assert.ok(isAppDefinition(app));
assert.equal(new SourceAccessDenied().name, 'SourceAccessDenied');
assert.deepEqual(Object.keys(await import('relate/storage')), []);
const consumer = await import('relate/consumer');
assert.equal(typeof consumer.createConsumer, 'function');
assert.equal(typeof consumer.createQuery, 'function');
await assert.rejects(import('@relate/node'), { code: 'ERR_MODULE_NOT_FOUND' });
await assert.rejects(import('@relate/runtime'), { code: 'ERR_MODULE_NOT_FOUND' });
console.log('Portable app and connector contracts work without Node host or runtime packages.');
`,
  );
  const portableResult = await execFile(process.execPath, ['smoke.mjs'], {
    cwd: portable,
  });

  process.stdout.write(portableResult.stdout);

  const consumer = join(temp, 'consumer');

  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies }),
  );
  await execFile(
    'npm',
    [
      'install',
      '--engine-strict',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: consumer },
  );
  await writeFile(
    join(consumer, 'sqlite-smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { stripe } from '@relate/connector-stripe';
import { salesforce } from '@relate/connector-salesforce';
import { sqlite } from '@relate/connector-sqlite';
const salesforceResource = salesforce({ credentials: { instanceUrl: 'https://fixture.my.salesforce.com', accessToken: 'fixture-token' }, apiVersion: '67.0', fetch: async url => Response.json(String(url).endsWith('/userinfo') ? { organization_id: '00D000000000001EAA' } : { done: true, totalSize: 1, records: [{ attributes: { type: 'Account' }, Id: '001000000000001AAA', IsDeleted: false, Name: 'Ada' }] }) }).resource('Account', { fields: ['Name'] });
assert.equal(await salesforceResource.identify({ signal: new AbortController().signal }), '00D000000000001EAA');
assert.deepEqual(await salesforceResource.fetch('001000000000001AAA', { signal: new AbortController().signal }), { state: 'present', providerAccountId: '00D000000000001EAA', record: { Id: '001000000000001AAA', IsDeleted: false, Name: 'Ada' } });
console.log('Installed Salesforce connector verifies org identity and reads Accounts in plain Node ESM.');
const billing = stripe({ apiKey: 'sk_test_fixture', apiVersion: '2025-06-30.basil', mode: 'test', fetch: async url => Response.json(String(url).endsWith('/account') ? { id: 'acct_packed', object: 'account' } : { id: 'cus_packed', object: 'customer', livemode: false, name: 'Ada' }) });
const stripeResource = billing.resource('customers', { fields: ['name'] });
assert.equal(await stripeResource.identify({ signal: new AbortController().signal }), 'acct_packed:test');
assert.deepEqual(await stripeResource.fetch('cus_packed', { signal: new AbortController().signal }), { state: 'present', providerAccountId: 'acct_packed:test', record: { id: 'cus_packed', name: 'Ada' } });
const db = new DatabaseSync('source.sqlite');
db.exec("CREATE TABLE account (id TEXT); INSERT INTO account VALUES ('packed'); CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT); INSERT INTO customers VALUES ('1', 'Ada')");
db.close();
const connection = sqlite({ path: 'source.sqlite', identity: { table: 'account', column: 'id' } });
const connector = connection.table('customers', { idColumn: 'id', columns: ['name'] });
try {
  assert.equal(await connector.identify({ signal: new AbortController().signal }), 'packed');
  assert.equal((await connector.fetch('1', { signal: new AbortController().signal })).record.name, 'Ada');
} finally { await connection.close(); }
const local = sqlite({ path: 'source.sqlite' });
try {
  const table = local.table('customers', { idColumn: 'id', columns: ['name'] });
  assert.equal(table.identity, 'application');
  assert.equal(table.identify, undefined);
  assert.deepEqual(await table.fetch('1', { signal: new AbortController().signal }), { state: 'present', record: { id: '1', name: 'Ada' } });
} finally { await local.close(); }
console.log('Installed SQLite connector reads both identity modes in plain Node ESM.');
`,
  );
  process.stdout.write(
    (await execFile(process.execPath, ['sqlite-smoke.mjs'], { cwd: consumer }))
      .stdout,
  );
  const program = `
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineAccess, defineGraph, defineObject, defineSource, source, objectId, from } from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime, createMemoryStore } from '@relate/runtime';
import { SourceAccessDenied } from 'relate/connectors';
import { createPostgresStore } from '@relate/postgres';
import { assertFields } from 'relate';
import { ReadError } from '@relate/protocol';
import { createQuery } from 'relate/consumer';
assert.equal('assertFields' in (await import('@relate/protocol')), false);
const pageRequests = [];
const query = createQuery(async (cursor) => {
  pageRequests.push(cursor);
  return cursor === undefined
    ? { data: ['first'], meta: { exhausted: false, continuationCursor: 'next' } }
    : { data: ['last'], meta: { exhausted: true } };
});
assert.equal(pageRequests.length, 0);
assert.deepEqual((await query).data, ['first']);
const paginated = [];
for await (const record of query) paginated.push(record);
assert.deepEqual(paginated, ['first', 'last']);
assert.deepEqual(pageRequests, [undefined, 'next']);
const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: { portfolio: z.string() } });
const crm = defineSource({ id: 'crm', idField: 'id', schema: z.object({ id: z.string(), name: z.string() }) });
const Customer = defineObject({ id: 'customer', label: 'Customer', membership: source(crm), properties: {
  id: objectId({ id: 'customer.id', access: access.groups.ordinary }),
  name: from(crm.fields.name, { id: 'customer.name', access: access.groups.ordinary }),
} });
const model = compile(defineGraph({ id: 'graph', objects: { Customer }, access, policies: { Customer: { read: 'deny' } } }));
assert.equal(model.manifest.objects[0].id, 'customer');
assert.equal(typeof createRuntime, 'function');
assert.equal(createMemoryStore().durability, 'volatile');
const memoryModel = compile(defineGraph({ id: 'graph', objects: { Customer }, access, policies: { Customer: { read: { gate: access.role('reader') } } } }));
const runtime = createRuntime({ model: memoryModel, graphId: 'smoke', sources: { crm: { connectionId: 'fixture', providerAccountId: 'example-account', authorization: 'shared-service', connector: { identify: async () => 'example-account', async fetch(id) { return { providerAccountId: 'example-account', state: 'present', record: { id, name: 'Ada' } }; } } } } });
const objectIdValue = await runtime.adopt('customer', '1');
const read = await runtime.read({ id: 'reader', roles: ['reader'], claims: {} }, 'customer', objectIdValue);
assertFields(read, ['name']);
assert.throws(() => assertFields(read, ['missing']), { name: 'ReadError', code: 'incomplete' });
assert.equal(read.data.name, 'Ada');
const graphPage = await runtime.query({ id: 'reader', roles: ['reader'], claims: {} }, 'customer', { where: { name: 'Ada' }, select: ['name'] });
assert.deepEqual(graphPage.data.map(row => row.id), [objectIdValue]);
assert.equal(graphPage.meta.exhausted, true);
assert.equal(read.meta.evidence, 'compact');
assert.equal(read.meta.fields, undefined);
const detailed = await runtime.read({ id: 'reader', roles: ['reader'], claims: {} }, 'customer', objectIdValue, { evidence: 'full' });
assert.equal(detailed.meta.evidence, 'full');
assert.equal(detailed.meta.fields.name.retentionDurability, 'volatile');
const store = createPostgresStore({ connectionString: 'postgresql://unused@127.0.0.1:1/unused' });
await store.close();
assert.equal(new ReadError('incomplete').code, 'incomplete');
assert.equal(new SourceAccessDenied().name, 'SourceAccessDenied');
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
const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: { portfolio: z.string() } });
const crm = defineSource({ id: 'crm', idField: 'id', schema: z.object({ id: z.string(), name: z.string() }) });
from(crm.fields.name, { id: 'customer.name', access: access.groups.ordinary });
// @ts-expect-error source references preserve field names
crm.fields.missing;
// Omitted field classification defaults to ordinary.
from(crm.fields.name, { id: 'customer.name' });
const identity = objectId({ id: 'customer.identity', access: access.groups.ordinary });
const idValue: string = identity.schema.parse('generated');
// @ts-expect-error Relate owns the ID validator
objectId(z.string(), { id: 'customer.identity', access: access.groups.ordinary });
// @ts-expect-error objects infer identity from objectId(), not a key selector
defineObject({ id: 'customer', label: 'Customer', key: 'id', membership: source(crm), properties: { id: identity } });
import { stripe } from '@relate/connector-stripe';
import { salesforce } from '@relate/connector-salesforce';
import { sqlite } from '@relate/connector-sqlite';
import { connect } from 'relate';
import type { SourceConnector, ApplicationSourceConnector } from 'relate/connectors';
const salesforceResource: SourceConnector = salesforce({ credentials: { instanceUrl: 'https://fixture.my.salesforce.com', accessToken: 'fixture' }, apiVersion: '67.0' }).resource('Account', { fields: ['Name'] });
connect(crm, { connectionId: 'salesforce', providerAccountId: '00D000000000001EAA', connector: salesforceResource });
const stripeResource: SourceConnector = stripe({ apiKey: 'sk_test_fixture', apiVersion: '2025-06-30.basil', mode: 'test' }).resource('customers', { fields: ['name'] });
connect(crm, { connectionId: 'stripe', providerAccountId: 'acct_fixture:test', connector: stripeResource });
const localResource: ApplicationSourceConnector = sqlite({ path: 'source.sqlite' }).table('customers', { idColumn: 'id', columns: ['name'] });
connect(crm, { connectionId: 'local', connector: localResource });
// @ts-expect-error application identity cannot claim a provider account
connect(crm, { connectionId: 'local', providerAccountId: 'fake', connector: localResource });
const resource: SourceConnector = sqlite({ path: 'source.sqlite', identity: { table: 'account', column: 'id' } }).table('customers', { idColumn: 'id', columns: ['name'] });
connect(crm, { connectionId: 'verified', providerAccountId: 'account', connector: resource });
// @ts-expect-error verified identity requires an expected account
connect(crm, { connectionId: 'verified', connector: resource });
export type Contracts = [ReadResult, ObservationStore, RuntimeOptions];
`,
  );
  await writeFile(
    join(consumer, 'assert-fields.types.ts'),
    await readFile(
      resolve(root, 'packages/relate/test/assert-fields.types.ts'),
      'utf8',
    ),
  );
  await writeFile(
    join(consumer, 'pagination.types.ts'),
    await readFile(
      resolve(root, 'packages/relate/test/pagination.types.ts'),
      'utf8',
    ),
  );
  await writeFile(
    join(consumer, 'authorization.types.ts'),
    await readFile(
      resolve(root, 'packages/relate/test/authorization.types.ts'),
      'utf8',
    ),
  );

  for (const name of ['model.ts', 'typed-read.types.ts']) {
    await writeFile(
      join(consumer, name),
      await readFile(resolve(root, 'packages/node/test', name), 'utf8'),
    );
  }

  await writeFile(
    join(consumer, 'invoice-graph.ts'),
    await readFile(resolve(root, 'tests/support/invoice-graph.ts'), 'utf8'),
  );

  for (const name of ['traversal.types.ts', 'object-ids.types.ts']) {
    await writeFile(
      join(consumer, name),
      (
        await readFile(resolve(root, 'packages/node/test', name), 'utf8')
      ).replaceAll(
        '../../../tests/support/invoice-graph.js',
        './invoice-graph.js',
      ),
    );
  }

  await writeFile(
    join(consumer, 'references.types.ts'),
    (
      await readFile(
        resolve(root, 'packages/relate/test/references.types.ts'),
        'utf8',
      )
    ).replaceAll(
      '../../../tests/support/invoice-graph.js',
      './invoice-graph.js',
    ),
  );

  await writeFile(
    join(consumer, 'traversal-smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { startApp } from '@relate/node';
import { connect, defineApp } from 'relate';
import { createInvoiceGraph } from './built/invoice-graph.js';
const { graph, ana, Customer, Invoice, customers, invoices } = createInvoiceGraph();
let setupCalls = 0;
let disposed = false;
const definition = defineApp({ graph, setup({ onDispose }) {
  setupCalls++;
  onDispose(() => { disposed = true; });
  return { connections: [
  connect(customers, { connectionId: 'crm', providerAccountId: 'example-account', connector: { identify: async () => 'example-account', fetch: async (id) => ({ providerAccountId: 'example-account', state: 'present', record: { id, name: 'Northwind', portfolio: 'north', revenue: 100 } }) } }),
  connect(invoices, { connectionId: 'billing', providerAccountId: 'example-account', connector: { identify: async () => 'example-account', fetch: async (id) => ({ providerAccountId: 'example-account', state: 'present', record: { id, customer_id: 'crm_1', status: 'open', total_minor: 12500 } }) } }),
] }; } });
assert.equal(setupCalls, 0);
const relate = await startApp(definition);
assert.equal(setupCalls, 1);
try {
  const customerId = await relate.host.adopt(Customer, 'crm_1');
  const invoiceId = await relate.host.adopt(Invoice, 'inv_1');
  const objects = relate.as(ana).objects;
  const page = await objects.Customer.traverse.invoices(customerId);
  assert.equal(page.data[0]?.id, invoiceId);
  const customer = await objects.Invoice.traverse.customer(invoiceId, { select: ['name'] });
  assert.equal(customer.status, 'ok');
  if (customer.status === 'ok') assert.equal(customer.id, customerId);
  const ids = [];
  for await (const invoice of objects.Customer.traverse.invoices(customerId)) ids.push(invoice.id);
  assert.deepEqual(ids, [invoiceId]);
} finally { await relate.close(); }
assert.equal(disposed, true);
console.log('Installed typed traversal and iteration run in plain Node ESM.');
`,
  );

  await writeFile(
    join(consumer, 'native-action-model.ts'),
    await readFile(
      resolve(root, 'tests/support/native-action-model.ts'),
      'utf8',
    ),
  );

  for (const [owner, name] of [
    ['relate', 'actions.types.ts'],
    ['node', 'native-action.types.ts'],
  ]) {
    await writeFile(
      join(consumer, name),
      (
        await readFile(resolve(root, 'packages', owner, 'test', name), 'utf8')
      ).replaceAll(
        '../../../tests/support/native-action-model.js',
        './native-action-model.js',
      ),
    );
  }

  await writeFile(
    join(consumer, 'native-action-smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { createRuntime } from '@relate/node';
import { connect } from 'relate';
import { graph, AddAccountReview, addAccountReview, ana, Customer, customers, invoices } from './built/native-action-model.js';
const app = createRuntime({ graph, actionImplementations: [addAccountReview], connections: [
  connect(customers, { connectionId: 'crm', providerAccountId: 'example-account', connector: { identify: async () => 'example-account', fetch: async (id) => ({ providerAccountId: 'example-account', state: 'present', record: { id, name: 'Northwind', portfolio: 'north' } }) } }),
  connect(invoices, { connectionId: 'billing', providerAccountId: 'example-account', connector: { identify: async () => 'example-account', fetch: async (id) => ({ providerAccountId: 'example-account', state: 'present', record: { id } }) } }),
] });
try {
  const customer = await app.host.adopt(Customer, 'northwind');
  const receipt = await app.as(ana).actions.addAccountReview({ input: { customer, note: 'Packed native action' }, idempotencyKey: 'one' });
  assert.equal(receipt.state, 'succeeded');
  assert.equal(typeof receipt.invocationId, 'string');
  assert.deepEqual(await app.as(ana).receipts.get(AddAccountReview, receipt.invocationId), receipt);
  assert.deepEqual(await app.as(ana).actions.addAccountReview({ input: { customer, note: 'Packed native action' }, idempotencyKey: 'one' }), receipt);
  const review = await app.as(ana).objects.AccountReview.get(receipt.output.reviewId);
  assert.equal(review.status, 'ok');
  assert.equal(review.data.note, 'Packed native action');
} finally { await app.close(); }
console.log('Installed native action executes and returns a readable committed review.');
`,
  );

  await writeFile(
    join(consumer, 'typed-read-smoke.ts'),
    `
import { z } from 'zod';
import {
  assertFields,
  connect,
  defineAccess,
  defineApp,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { startApp } from '@relate/node';

const access = defineAccess({ roles: ['reader'], fieldGroups: ['ordinary'], claims: {} });
const people = defineSource({
  id: 'smoke.people',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string(), at: z.iso.datetime({ offset: true, precision: 3 }) }),
});
const Person = defineObject({
  id: 'smoke.person',
  label: 'Person',
  membership: source(people),
  properties: {
    id: objectId({ id: 'smoke.person.id' }),
    name: from(people.fields.name, { id: 'smoke.person.name' }),
    at: from(people.fields.at, { id: 'smoke.person.at' }),
  },
});
const graph = defineGraph({
  id: 'smoke.graph',
  objects: { Person },
  access,
  policies: { Person: { read: { gate: access.role('reader') } } },
});
const relate = await startApp(
  defineApp({
    graph,
    setup: () => ({
      graphId: 'typed-read-smoke',
      connections: [
        connect(people, {
          providerAccountId: 'smoke-account',
          connectionId: 'smoke',
          connector: {
            identify: async () => 'smoke-account',
            fetch: async (id: string) =>
              id === '1'
                ? { providerAccountId: 'smoke-account', state: 'present' as const, record: { id: '1', name: 'Ada', at: '2026-10-01T01:00:00.000+01:00' } }
                : { providerAccountId: 'smoke-account', state: 'deleted' as const },
          },
        }),
      ],
    }),
  }),
);
try {
  const id = await relate.host.adopt(Person, '1');
  const result = await relate
    .as({ id: 'reader', roles: ['reader'], claims: {} })
    .objects.Person.get(id, { select: ['name'] });
  assertFields(result, ['name']);
  const name: string = result.data.name;
  const page = await relate.as({ id: 'reader', roles: ['reader'], claims: {} }).objects.Person.query({
    where: { name: { in: ['Ada'] }, at: { gte: '2026-10-01T00:00:00.000Z', lt: '2026-10-02T00:00:00.000Z' } },
    select: ['name'],
  });
  if (page.data.length !== 1 || page.data[0]!.id !== id) throw new Error('Packed timestamp query did not match');
  console.log(JSON.stringify({ ...result, typedName: name }));
} finally {
  await relate.close();
}
`,
  );
  await execFile(
    process.execPath,
    [
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--outDir',
      'built',
      '--strict',
      '--noUncheckedIndexedAccess',
      '--exactOptionalPropertyTypes',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'types.ts',
      'assert-fields.types.ts',
      'pagination.types.ts',
      'authorization.types.ts',
      'references.types.ts',
      'typed-read.types.ts',
      'typed-read-smoke.ts',
      'traversal.types.ts',
      'object-ids.types.ts',
      'actions.types.ts',
      'native-action.types.ts',
    ],
    { cwd: consumer },
  );
  console.log('Installed NodeNext consumer types pass.');
  const traversal = await execFile(process.execPath, ['traversal-smoke.mjs'], {
    cwd: consumer,
  });

  process.stdout.write(traversal.stdout);
  const native = await execFile(process.execPath, ['native-action-smoke.mjs'], {
    cwd: consumer,
  });

  process.stdout.write(native.stdout);
  const typedRead = await execFile(
    process.execPath,
    ['built/typed-read-smoke.js'],
    { cwd: consumer },
  );
  const read = JSON.parse(typedRead.stdout);

  assert.equal(read.status, 'ok');
  assert.equal(typeof read.id, 'string');
  assert.notEqual(read.id, '1');
  assert.deepEqual(read.data, { name: 'Ada' });
  assert.equal(read.typedName, 'Ada');
  assert.equal(read.meta.evidence, 'compact');
  assert.equal(read.meta.fields, undefined);
  console.log(
    'A typed, authorized read runs from installed tarballs in plain Node ESM.',
  );

  // Structured diagnostics and the inspector entry points install cleanly.
  await writeFile(
    join(consumer, 'inspector-smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { CompileError } from 'relate/diagnostics';
import { ManifestValidationError, validateManifest } from 'relate/model';
import { defineApp, isAppDefinition } from 'relate';
import { PROTOCOL_VERSION, parseDevEvent } from '@relate/inspector/protocol';
import { createInspectorApp } from '@relate/inspector/server';
import { createInvoiceGraph } from './built/invoice-graph.js';
const { graph } = createInvoiceGraph();
try { validateManifest({ formatVersion: 2 }); assert.fail('expected failure'); }
catch (error) { assert.ok(error instanceof ManifestValidationError); assert.equal(error.issues[0].code, 'manifest.invalid-shape'); }
assert.equal(new CompileError([{ code: 'policy.missing', message: 'x' }]).name, 'CompileError');
assert.ok(isAppDefinition(defineApp({ graph })));
assert.equal(parseDevEvent({ protocolVersion: PROTOCOL_VERSION, instanceId: 'i', sequence: 0, type: 'snapshot', model: null, failure: null }).type, 'snapshot');
await createInspectorApp().verify();
console.log('Installed inspector protocol and packaged assets load.');
`,
  );
  const inspector = await execFile(process.execPath, ['inspector-smoke.mjs'], {
    cwd: consumer,
  });

  process.stdout.write(inspector.stdout);

  // One command serves the graph from the installed CLI: no frontend build,
  // database, credentials or provider calls.
  await writeFile(
    join(consumer, 'relate.config.ts'),
    "import { defineApp } from 'relate';\nimport { createInvoiceGraph } from './invoice-graph.js';\nconst { graph } = createInvoiceGraph();\nexport default defineApp({ graph, setup() { throw new Error('Inspector must not execute setup'); } });\n",
  );
  const port = await new Promise((resolvePort, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();

      probe.close(() => resolvePort(port));
    });
  });
  const dev = spawn(
    process.execPath,
    ['node_modules/@relate/cli/bin/relate.js', 'dev', '--port', String(port)],
    { cwd: consumer, env: { ...process.env, NO_COLOR: '1' } },
  );
  const devOutput = [];

  dev.stdout.on('data', (chunk) => devOutput.push(chunk));
  dev.stderr.on('data', (chunk) => devOutput.push(chunk));

  try {
    const deadline = Date.now() + 30_000;

    while (
      !/ready\s+gen 1\s+invoice-read/.test(Buffer.concat(devOutput).toString())
    ) {
      if (dev.exitCode !== null || Date.now() > deadline)
        throw new Error(
          `relate dev did not publish a model:\n${Buffer.concat(devOutput)}`,
        );

      await new Promise((tick) => setTimeout(tick, 100));
    }

    const identity = await fetch(`http://127.0.0.1:${port}/dev/instance`);

    assert.equal(identity.status, 200);
    const shell = await fetch(`http://127.0.0.1:${port}/`);

    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /<div id="root">/);
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/dev/snapshot`)).status,
      401,
    );
    console.log(
      'Installed relate dev serves the inspector and compiles the graph.',
    );
  } finally {
    const exited = new Promise((resolveExit) => dev.once('exit', resolveExit));

    dev.kill('SIGINT');
    await exited;
  }
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);

  if (error.stderr) process.stderr.write(error.stderr);

  throw error;
} finally {
  await rm(temp, { recursive: true, force: true });
}
