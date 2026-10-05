import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import { createPostgresStore } from '@relate/postgres';
import { startCrmSimulator } from '../../../dev/simulators/crm/index.js';
import { Customer, customerGraph, employee, finance } from './model.js';
import { crmConnector } from './connector.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl)
  throw new Error(
    'Set DATABASE_URL to an existing Postgres database before running this example.',
  );

let crm: Awaited<ReturnType<typeof startCrmSimulator>> | undefined;
let store = createPostgresStore({ connectionString: databaseUrl });

try {
  crm = await startCrmSimulator();
  await store.migrate();
  let now = Date.now();
  const options = {
    model: compile(customerGraph),
    graphId: 'postgres-persistence',
    clock: () => now,
    sources: {
      'crm.customers': {
        connectionId: 'crm-account-north',
        authorization: 'shared-service' as const,
        connector: crmConnector(crm.url),
      },
    },
  };
  let runtime = createRuntime({ ...options, store });
  const objectId = await runtime.adopt(Customer.definitionId, 'crm_456');
  const show = (event: string, result: unknown) =>
    console.log(JSON.stringify({ event, result }, null, 2));

  show(
    'employee-read',
    await runtime.read(employee, Customer.definitionId, objectId, {
      select: ['id', 'name', 'revenue'],
    }),
  );
  await crm.update({ display_name: 'Northwind Studio' });
  now += 1_000;
  show(
    'finance-refresh',
    await runtime.read(finance, Customer.definitionId, objectId, {
      refresh: true,
    }),
  );
  await crm.stop();
  await store.close();
  store = createPostgresStore({ connectionString: databaseUrl });
  runtime = createRuntime({ ...options, store });
  now += 2_000;
  show(
    'durable-fallback',
    await runtime.read(employee, Customer.definitionId, objectId, {
      select: ['name'],
      maxAgeMs: 1_000,
    }),
  );
  now += 30_001;
  show(
    'expired-permission',
    await runtime.read(employee, Customer.definitionId, objectId),
  );
} finally {
  await store.close();
  await crm?.stop();
}
