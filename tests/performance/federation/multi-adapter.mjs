// Benchmark-owned multi-dataset model and Parquet baseline, not public APIs.
import { z } from 'zod';
import {
  bind,
  defineAccess,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { startApp } from '@relate/node';
import { createMemoryStore } from '@relate/runtime';
import {
  analyticalParameterBudget,
  renderAnalyticalQuery,
} from 'relate/analytics';
import {
  dialect,
  datafusionResource,
  scopeResource,
} from './relate-adapter.mjs';
import { withScopeExecutor } from './scope-executor.mjs';
import { assertInstalled } from './register.mjs';
import { since, until } from './queries.mjs';

export function parquetResource(dc) {
  const selections = new WeakMap(),
    plans = new WeakMap();
  const selected = (handle) => {
    const selection = selections.get(handle);

    if (!selection) throw new Error('Foreign Parquet resource');

    return selection;
  };

  return {
    resourceId: 'file_events',
    bindDataset(selection) {
      const handle = Object.freeze({});

      selections.set(handle, selection);

      return handle;
    },
    connection: {
      connectionId: 'federation-parquet',
      system: 'duckdb-parquet-spike',
      analytics: {
        limits: { maxParameters: 65535, maxConcurrentStatements: 1 },
        async describe(handle, { signal }) {
          signal.throwIfAborted();
          const physical = (
            await dc.runAndReadAll('DESCRIBE SELECT * FROM file_events')
          ).getRowObjects();

          return {
            columns: Object.fromEntries(
              Object.entries(selected(handle).columns).flatMap(
                ([name, column]) => {
                  const found = physical.find((c) => c.column_name === column);

                  return found
                    ? [
                        [
                          name,
                          {
                            supportedTypes:
                              found.column_type === 'VARCHAR'
                                ? [{ type: 'string' }]
                                : [],
                            nullable: found.null === 'YES',
                            databaseType: found.column_type,
                          },
                        ],
                      ]
                    : [];
                },
              ),
            ),
          };
        },
        parameterBudget: (query) => analyticalParameterBudget(query, dialect),
        plan(query) {
          const handle = Object.freeze({});

          plans.set(
            handle,
            renderAnalyticalQuery(
              query,
              {
                table: 'file_events',
                columns: selected(query.resource).columns,
              },
              query.slots,
              dialect,
            ),
          );

          return handle;
        },
        async execute(handle, { signal }) {
          signal.throwIfAborted();
          const plan = plans.get(handle);

          if (!plan) throw new Error('Foreign Parquet plan');

          const readAt = new Date().toISOString();
          const rows = (await dc.runAndReadAll(plan.sql)).getRowObjects();

          signal.throwIfAborted();

          return {
            readAt,
            rows: rows.map((row) => ({
              slot: row.slot,
              values: plan.results.map((_, i) => row[`v${i}`] ?? null),
            })),
          };
        },
      },
    },
  };
}

export async function openMultiRelate(
  fixture,
  transport,
  store = createMemoryStore(),
  options = {},
) {
  if (options.scope) assertInstalled();

  const access = defineAccess({
    roles: ['employee', 'finance'],
    fieldGroups: ['ordinary'],
    claims: { portfolio: z.string() },
  });
  const customers = defineSource({
    id: 'federation.customers',
    idField: 'key',
    schema: z.object({
      key: z.string(),
      name: z.string(),
      portfolio: z.string(),
    }),
  });
  const column = (id, schema) => ({
    id,
    schema,
    access: access.groups.ordinary,
  });
  const FileEvents = defineDataset({
    id: 'federation.file-events',
    columns: {
      customer: column('file.customer', z.string().nullable()),
      eventType: column('file.type', z.string().nullable()),
      occurredAt: column('file.at', z.string().nullable()),
    },
  });
  const Invoices = defineDataset({
    id: 'federation.invoices',
    columns: {
      customer: column('invoice.customer', z.string()),
      amount: column('invoice.amount', z.int64().nullable()),
      paid: column('invoice.paid', z.boolean()),
    },
  });
  const Customer = defineObject({
    id: 'federation.customer',
    membership: source(customers),
    properties: {
      id: objectId({ id: 'federation.customer.id' }),
      key: from(customers.fields.key, { id: 'federation.customer.key' }),
      name: from(customers.fields.name, { id: 'federation.customer.name' }),
      portfolio: from(customers.fields.portfolio, {
        id: 'federation.customer.portfolio',
      }),
    },
    datasets: {
      events: {
        id: 'federation.customer.events',
        dataset: FileEvents,
        on: [{ column: 'customer', property: 'key' }],
      },
      invoices: {
        id: 'federation.customer.invoices',
        dataset: Invoices,
        on: [{ column: 'customer', property: 'key' }],
      },
    },
  });
  const graph = defineGraph({
    id: 'federation.multi',
    objects: { Customer },
    datasets: { FileEvents, Invoices },
    access,
    policies: {
      FileEvents: {},
      Invoices: {},
      Customer: {
        read: {
          gate: access.role('employee'),
          evidenceMaxAgeMs: 86400000,
          where: { portfolio: { eq: access.claims.portfolio } },
        },
        datasets: {
          events: { gate: access.role('employee') },
          invoices: { gate: access.role('finance') },
        },
      },
    },
  });
  const sources = new WeakMap();
  const resource = (original, table) =>
    options.scope
      ? scopeResource(original, sources, table)
      : transport
        ? datafusionResource(original, transport, table)
        : original;
  const byKey = new Map(fixture.records.map((row) => [row.key, row]));
  const app = await startApp(
    defineApp({
      graph,
      setup: () => ({
        graphId: 'federation-multi-public-benchmark',
        store,
        activity: { operations: 'disabled' },
        bindings: [
          bind(FileEvents, resource(fixture.fileResource, 'file_events'), {
            columns: { eventType: 'type', occurredAt: 'at' },
          }),
          bind(Invoices, resource(fixture.invoiceResource, 'invoices')),
          bind(customers, {
            connectionId: 'federation-multi',
            resourceId: 'customers',
            providerAccountId: 'synthetic',
            connector: {
              identify: async () => 'synthetic',
              fetch: async (key) => ({
                state: 'present',
                providerAccountId: 'synthetic',
                record: { ...byKey.get(key) },
              }),
            },
          }),
        ],
      }),
    }),
  );
  const ids = new Map();

  try {
    for (const row of fixture.records)
      ids.set(row.key, await app.host.adopt(Customer, row.key));
  } catch (error) {
    await app.close();
    throw error;
  }

  const request = {
    select: ['key', 'name'],
    where: { portfolio: 'north' },
    limit: 25,
    compute: {
      loginCount: {
        sql: "SELECT COUNT(*) FROM self.events WHERE eventType = 'login' AND occurredAt >= $since AND occurredAt < $until",
        parameters: { since, until },
      },
      lastLogin: {
        sql: "SELECT MAX(occurredAt) FROM self.events WHERE eventType = 'login' AND occurredAt >= $since AND occurredAt < $until",
        parameters: { since, until },
      },
      paidTotal: {
        sql: 'SELECT COALESCE(SUM(amount), 0) FROM self.invoices WHERE paid = true',
      },
    },
    orderBy: [{ field: 'loginCount', direction: 'desc' }],
  };
  const expected = fixture
    .expected('multi-bulk')
    .sort(
      (a, b) =>
        Number(b.login_count) - Number(a.login_count) ||
        (ids.get(a.key) < ids.get(b.key) ? -1 : 1),
    )
    .slice(0, 25);
  const rawQuery = (
    overrides = {},
    principal = {
      id: 'benchmark-reader',
      roles: ['employee', 'finance'],
      claims: { portfolio: 'north' },
    },
  ) => {
    const run = () =>
      app.as(principal).objects.Customer.query({ ...request, ...overrides });

    return options.scope
      ? withScopeExecutor(
          {
            transport,
            sources,
            mode: options.mode,
            explain: options.explain,
            onExecution: options.onExecution,
          },
          run,
        )
      : run();
  };

  return {
    expected,
    ids,
    rawQuery,
    request,
    refresh(key) {
      return app
        .as({
          id: 'source-refresh',
          roles: ['employee', 'finance'],
          claims: { portfolio: byKey.get(key).portfolio },
        })
        .objects.Customer.get(ids.get(key), {
          select: ['key', 'portfolio'],
          refresh: true,
        });
    },
    async query() {
      const result = await rawQuery();

      if (!Array.isArray(result.data)) throw new Error(JSON.stringify(result));

      return {
        rows: result.data.map((row) => ({
          key: row.data.key,
          name: row.data.name,
          login_count: row.data.loginCount,
          last_login: row.data.lastLogin,
          paid: row.data.paidTotal,
        })),
      };
    },
    close: () => app.close(),
  };
}
