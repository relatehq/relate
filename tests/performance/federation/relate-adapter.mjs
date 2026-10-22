// Narrow spike adapter: only the benchmark's COUNT/MAX types, immutable local
// sources and successful completion are supported. Not a production connector.
import {
  renderAnalyticalQuery,
  analyticalParameterBudget,
  encodeAnalyticalValue,
} from 'relate/analytics';
import { createMemoryStore } from '@relate/runtime';
import { openObjects } from '../analytical-properties/model.ts';
import { scenarios } from '../analytical-properties/scenarios.ts';
import { utcTimestamp } from './queries.mjs';

const dialect = {
  bind(value) {
    const encoded = encodeAnalyticalValue(value.value, {
      ...value,
      nullable: true,
    });
    const type = {
      string: 'VARCHAR',
      boolean: 'BOOLEAN',
      int32: 'INT',
      int64: 'BIGINT',
      timestamp: 'TIMESTAMP',
      float64: 'DOUBLE',
    }[value.type];

    if (!type) throw new Error(`Unsupported spike type: ${value.type}`);

    const literal =
      encoded === null
        ? 'NULL'
        : typeof encoded === 'boolean'
          ? String(encoded)
          : `'${String(encoded).replaceAll("'", "''")}'`;

    return { sql: `CAST(${literal} AS ${type})`, value: encoded };
  },
  operand(sql) {
    return sql;
  },
  operator(op) {
    return op;
  },
  aggregate(value, argument, filter) {
    if (!['count', 'max'].includes(value.aggregate))
      throw new Error('Spike only supports COUNT/MAX');

    return `${value.aggregate.toUpperCase()}(${value.distinct ? 'DISTINCT ' : ''}${argument}) FILTER (WHERE ${filter})`;
  },
  timestamp(sql) {
    return sql;
  },
  timestampParameters: 0,
};

export function datafusionResource(original, transport) {
  const selections = new WeakMap(),
    plans = new WeakMap();
  const resource = {
    ...original,
    bindDataset(selection) {
      const handle = original.bindDataset(selection);

      selections.set(handle, selection);

      return handle;
    },
    connection: {
      ...original.connection,
      analytics: {
        ...original.connection.analytics,
        parameterBudget(query) {
          return analyticalParameterBudget(query, dialect);
        },
        plan(query) {
          const selection = selections.get(query.resource);

          if (!selection) throw new Error('Foreign spike resource');

          const plan = renderAnalyticalQuery(
            query,
            { table: 'events', columns: selection.columns },
            query.slots,
            dialect,
          );
          const handle = Object.freeze({});

          plans.set(handle, plan);

          return handle;
        },
        async execute(handle, { signal, timeoutMs }) {
          signal.throwIfAborted();
          const plan = plans.get(handle);

          if (!plan) throw new Error('Foreign spike plan');

          const readAt = new Date().toISOString();
          const result = await transport.query({
            sql: plan.sql,
            timeoutMs,
            // Federation 0.5.5 cannot unparse the renderer's VALUES input.
            // Explicit scan mode; retain this limitation in the report.
            mode: 'scan',
          });

          // We wait for completion even when aborted: no early release of host capacity.
          // Remote statement cancellation still needs a production implementation.
          signal.throwIfAborted();

          if (result.rows.length !== plan.slots)
            throw new Error('Wrong slot count');

          return {
            readAt,
            rows: result.rows.map((row, slot) => {
              if (row.slot !== slot) throw new Error('Wrong slot order');

              return {
                slot,
                values: plan.results.map((type, index) => {
                  const value = row[`v${index}`];

                  if (value == null) return null;

                  if (type.type === 'int64') {
                    if (!Number.isSafeInteger(value))
                      throw new Error('Unsafe spike JSON integer');

                    return BigInt(value);
                  }

                  if (type.type === 'timestamp') return utcTimestamp(value);

                  return value;
                }),
              };
            }),
          };
        },
      },
    },
  };

  return resource;
}

export async function openRelate(
  fixture,
  transport,
  store = createMemoryStore(),
) {
  const objects = await openObjects(fixture.records, {
    graphId: 'federation-public-benchmark',
    store,
    resource: transport
      ? datafusionResource(fixture.resource, transport)
      : fixture.resource,
    capture: 'disabled',
    freshness: 'cached',
    sourceDelayMs: 0,
  });
  const request = {
    ...scenarios.ranking,
    select: ['key', 'name'],
    orderBy: [{ field: 'loginCount', direction: 'desc' }],
  };

  const expected = fixture
    .expected('bulk')
    .sort((a, b) => {
      const difference = Number(b.login_count) - Number(a.login_count);
      const left = objects.ids.get(a.key),
        right = objects.ids.get(b.key);

      return difference || (left < right ? -1 : left > right ? 1 : 0);
    })
    .slice(0, 25);

  return {
    expected,
    async query() {
      const result = await objects.customer.query(request);

      if (!Array.isArray(result.data)) throw new Error(JSON.stringify(result));

      return {
        rows: result.data.map((row) => ({
          key: row.data.key,
          name: row.data.name,
          login_count: row.data.loginCount,
          last_login: row.data.lastLogin,
        })),
      };
    },
    close: () => objects.app.close(),
  };
}
