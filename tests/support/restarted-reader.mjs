import { createRuntime } from '@relate/runtime';
import { createPostgresStore } from '@relate/postgres';

const config = JSON.parse(process.argv[2]);
const store = createPostgresStore({ connectionString: config.databaseUrl });

try {
  const runtime = createRuntime({
    model: config.model,
    graphId: config.graphId,
    store,
    clock: () => config.now,
    sources: {
      'crm.customers': {
        connectionId: 'crm-primary',
        authorization: 'shared-service',
        connector: {
          async fetch(key, { signal }) {
            const result = await fetch(
              `${config.crmUrl}/customers/${encodeURIComponent(key)}`,
              { signal },
            );

            if (!result.ok) throw new Error('CRM unavailable');

            return result.json();
          },
        },
      },
    },
  });

  console.log(
    JSON.stringify(
      await runtime.read(config.principal, config.type, config.key, {
        select: ['name'],
        maxAgeMs: 1_000,
      }),
    ),
  );
} finally {
  await store.close();
}
