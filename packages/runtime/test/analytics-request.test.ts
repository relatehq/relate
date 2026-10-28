import { afterEach, expect, it } from 'vitest';
import { createSqlParser } from '@relate/sql-parser';
import type {
  PreparedPlan,
  DatasetResource,
  AuthorizedDatasetQuery,
} from 'relate/connectors';
import {
  prepareCompute,
  computeFields,
  createStatementQueue,
  createAnalyticalTimings,
  AnalyticalPreparationError,
} from '../src/analytics/index.js';
import type {
  ActorAssociations,
  ComputeRequest,
  DeclaredCalculationRequest,
  PreparedCompute,
  AnalyticalBinding,
} from '../src/analytics/index.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function declarations(): ActorAssociations {
  return {
    properties: [
      {
        id: 'customer.key',
        name: 'key',
        calculated: false,
        readable: true,
        schema: { type: 'string', nullable: false },
      },
      {
        id: 'customer.since',
        name: 'since',
        calculated: false,
        readable: true,
        schema: { type: 'timestamp', precision: 3, nullable: false },
      },
      {
        id: 'customer.count',
        name: 'loginCount',
        calculated: true,
        readable: true,
      },
    ],
    associations: [
      {
        id: 'customer.events',
        name: 'events',
        datasetDefinitionId: 'events',
        on: [
          {
            propertyDefinitionId: 'customer.key',
            columnDefinitionId: 'events.key',
          },
        ],
        columns: [
          {
            id: 'events.key',
            name: 'customerId',
            readable: true,
            schema: { type: 'string', nullable: false },
          },
          {
            id: 'events.at',
            name: 'at',
            readable: true,
            schema: { type: 'timestamp', precision: 3, nullable: false },
          },
        ],
      },
    ],
  };
}

function declared(
  overrides: Partial<DeclaredCalculationRequest> = {},
): DeclaredCalculationRequest {
  return {
    name: 'loginCount',
    definitionId: 'customer.count',
    sql: 'SELECT COUNT(*) FROM self.events',
    readable: true,
    project: true,
    required: false,
    ...overrides,
  };
}

async function prepare(
  request: ComputeRequest,
  scope = declarations(),
  limits = {},
) {
  return prepareCompute({
    parser: await createSqlParser(),
    associations: scope,
    declarations: declarations(),
    request,
    limits,
  });
}

function execute(prepared: PreparedCompute) {
  const plans = new WeakMap<PreparedPlan, AuthorizedDatasetQuery>();
  const queries: AuthorizedDatasetQuery[] = [];
  const queue = createStatementQueue();

  cleanups.push(() => queue.retire());
  const binding: AnalyticalBinding = {
    resource: {} as DatasetResource,
    queue,
    bindingRevision: 'test',
    connector: {
      limits: { maxParameters: 100 },
      async describe() {
        return { columns: {} };
      },
      parameterBudget: () => ({ fixed: 0, perSlot: 4 }),
      plan(query) {
        const handle = {} as PreparedPlan;

        plans.set(handle, query);
        queries.push(query);

        return handle;
      },
      async execute(handle) {
        const query = plans.get(handle)!;

        return {
          readAt: '2026-10-21T00:00:00.000Z',
          rows: query.slots.map((_, slot) => ({
            slot,
            values: query.aggregates.map(() => 4n),
            checks: query.aggregates.map(() => ({ arithmeticFailed: false })),
          })),
        };
      },
    },
  };
  const result = computeFields({
    prepared,
    signal: new AbortController().signal,
    binding: () => binding,
    candidates: [
      {
        id: 'one',
        dependencies: {
          'customer.key': {
            value: { type: 'string', value: 'key-one' },
            evidence: {
              status: 'available',
              source: 'native',
              freshness: 'fresh',
              observedAt: '2026-10-21T00:00:00.000Z',
              retention: 'confirmed',
              retentionDurability: 'volatile',
              ordering: 'confirmed',
              refresh: 'not-needed',
            },
          },
        },
      },
    ],
  });

  return { result, queries };
}

it('prepares caller and declared calculations together, sharing dependencies and one statement', async () => {
  const prepared = await prepare({
    compute: { customCount: { sql: 'SELECT COUNT(*) FROM self.events' } },
    declarations: [declared()],
  });

  expect(prepared.dependencies).toEqual(['customer.key']);
  expect(prepared.results).toEqual({
    customCount: { type: 'int64', nullable: false },
    loginCount: { type: 'int64', nullable: false },
  });
  const { result, queries } = execute(prepared);

  expect((await result).rows.get('one')).toMatchObject({
    customCount: { status: 'available', value: '4' },
    loginCount: { status: 'available', value: '4' },
  });
  expect(queries).toHaveLength(1);
  expect(queries[0]!.aggregates).toHaveLength(2);
});

it.each([
  'key',
  'loginCount',
  '__proto__',
  'constructor',
  'prototype',
  '',
  'bad\0name',
])('rejects unsafe or colliding alias %j before parsing', async (name) => {
  const parser = await createSqlParser();
  let parses = 0;

  expect(() =>
    prepareCompute({
      parser: {
        ...parser,
        parse(sql) {
          parses++;

          return parser.parse(sql);
        },
      },
      declarations: declarations(),
      associations: declarations(),
      request: {
        compute: Object.fromEntries([[name, { sql: 'bad SQL' }]]),
        declarations: [],
      },
    }),
  ).toThrow(AnalyticalPreparationError);
  expect(parses).toBe(0);
});

it.each([null, [], 'expression', new Date(), new Map()])(
  'rejects a non-record compute map %j',
  async (compute) => {
    await expect(prepare({ compute, declarations: [] })).rejects.toBeInstanceOf(
      AnalyticalPreparationError,
    );
  },
);

it('counts declared calculations against the same expression budget as caller aliases', async () => {
  await expect(
    prepare(
      {
        compute: { count: { sql: 'SELECT COUNT(*) FROM self.events' } },
        declarations: [declared()],
      },
      declarations(),
      { maxExpressions: 1 },
    ),
  ).rejects.toMatchObject({
    issues: [{ path: ['compute'], problem: 'invalid-value' }],
  });
  await expect(
    prepare({ declarations: [declared()] }, declarations(), {
      maxExpressions: 1,
    }),
  ).resolves.toHaveProperty('results.loginCount');
});

it('checks SQL size for declarations and callers even with no candidate objects', async () => {
  await expect(
    prepare({ declarations: [declared()] }, declarations(), { maxSqlBytes: 5 }),
  ).rejects.toMatchObject({
    issues: [{ path: ['select', 'loginCount'], problem: 'invalid-value' }],
  });
  await expect(
    prepare(
      {
        declarations: [],
        compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
      },
      declarations(),
      { maxSqlBytes: 5 },
    ),
  ).rejects.toMatchObject({ issues: [{ path: ['compute', 'n', 'sql'] }] });
});

it('returns original SQL spans with alias-specific paths on caller errors', async () => {
  await expect(
    prepare({
      declarations: [],
      compute: { n: { sql: 'SELECT COUNT(missing) FROM self.events' } },
    }),
  ).rejects.toMatchObject({
    issues: [
      {
        path: ['compute', 'n', 'sql'],
        problem: 'unknown-property',
        at: { start: 13, end: 20 },
      },
    ],
  });
});

it('rejects hidden caller associations while withholding declared values without exposing their names', async () => {
  const scope = { ...declarations(), associations: [] };

  await expect(
    prepare(
      {
        declarations: [],
        compute: { n: { sql: 'SELECT COUNT(*) FROM self.events' } },
      },
      scope,
    ),
  ).rejects.toMatchObject({ issues: [{ problem: 'unknown-property' }] });
  const prepared = await prepare({ declarations: [declared()] }, scope);

  expect(prepared.dependencies).toEqual([]);
  expect(JSON.stringify(prepared)).not.toMatch(/events|SELECT/);
  const { result, queries } = execute(prepared);

  expect((await result).rows.get('one')!.loginCount).toEqual({
    status: 'forbidden',
  });
  expect(queries).toHaveLength(0);
});

it.each(['property', 'column', 'self', 'correlation'] as const)(
  'applies actor %s restrictions to declared SQL',
  async (denied) => {
    const scope = declarations();
    const view: ActorAssociations = {
      properties: scope.properties.map((property) => ({
        ...property,
        readable: !(
          (denied === 'property' && property.name === 'loginCount') ||
          (denied === 'self' && property.name === 'since') ||
          (denied === 'correlation' && property.name === 'key')
        ),
      })),
      associations: scope.associations.map((association) => ({
        ...association,
        columns: association.columns.map((column) => ({
          ...column,
          readable: !(denied === 'column' && column.name === 'at'),
        })),
      })),
    };
    const prepared = await prepare(
      {
        declarations: [
          declared({
            sql: 'SELECT COUNT(*) FROM self.events WHERE at >= self.since',
          }),
        ],
      },
      view,
    );

    expect(prepared.dependencies).toEqual([]);
    const { result, queries } = execute(prepared);

    expect((await result).rows.get('one')!.loginCount).toEqual(
      denied === 'correlation'
        ? { status: 'unavailable', reason: 'correlation-unavailable' }
        : { status: 'forbidden' },
    );
    expect(queries).toHaveLength(0);
  },
);

it('keeps required declarations private unless projected and rejects missing required values', async () => {
  const prepared = await prepare({
    declarations: [
      declared({
        project: false,
        required: true,
        sql: 'SELECT COUNT(*) FROM self.events WHERE at >= self.since',
      }),
    ],
  });

  expect(prepared.results).toEqual({});
  expect(prepared.dependencies).toEqual(['customer.key', 'customer.since']);
  await expect(execute(prepared).result).rejects.toMatchObject({
    fields: { loginCount: { reason: 'correlation-unavailable' } },
  });
});

it('detaches values from caller and model mutations, without enumerating SQL or parameters', async () => {
  const request = {
    compute: {
      n: {
        sql: 'SELECT COUNT(*) FROM self.events WHERE customerId = $key',
        parameters: { key: 'private-key' },
      },
    },
    declarations: [],
  };
  const scope = declarations();
  const prepared = await prepare(request, scope);

  request.compute.n.sql = 'DELETE FROM events';
  request.compute.n.parameters.key = 'changed';
  Object.assign(scope.associations[0]!, { on: [] });
  expect(JSON.stringify(prepared)).not.toMatch(
    /SELECT|private-key|parameters|events/,
  );
  const { result, queries } = execute(prepared);

  await result;
  expect(queries[0]!.correlation).toHaveLength(1);
  expect(queries[0]!.aggregates[0]).toMatchObject({
    predicate: {
      right: { kind: 'value', value: { type: 'string', value: 'private-key' } },
    },
  });
});

it('rejects forged and reused preparation handles', async () => {
  const prepared = await prepare({ declarations: [] });
  const run = (handle: PreparedCompute) =>
    computeFields({
      prepared: handle,
      candidates: [],
      binding: () => {
        throw new Error('not reached');
      },
      signal: new AbortController().signal,
    });

  await expect(run({ ...prepared })).rejects.toThrow('Unknown or consumed');
  await expect(run(prepared)).resolves.toMatchObject({ results: {} });
  await expect(run(prepared)).rejects.toThrow('Unknown or consumed');
});

it('records preparation timing on rejected requests without adding execution stages', async () => {
  const capture = createAnalyticalTimings();
  const parser = await createSqlParser();

  expect(() =>
    prepareCompute({
      parser,
      declarations: declarations(),
      associations: declarations(),
      request: { declarations: [], compute: { count: { sql: 'bad SQL' } } },
      timings: capture,
    }),
  ).toThrow();
  expect(capture.snapshot().stages.preparation!.count).toBe(1);
  expect(Object.keys(capture.snapshot().stages)).toEqual(['preparation']);
});

it('requires a caller alias used by a normalized filter or order even without requireComplete', async () => {
  const prepared = await prepare({
    compute: {
      n: { sql: 'SELECT COUNT(*) FROM self.events WHERE at >= self.since' },
    },
    declarations: [],
    requiredAliases: ['n'],
  });

  await expect(execute(prepared).result).rejects.toMatchObject({
    fields: { n: { reason: 'correlation-unavailable' } },
  });
});

it('rejects declaration identity substitution and unknown normalized required aliases', async () => {
  await expect(
    prepare({ declarations: [declared({ definitionId: 'customer.key' })] }),
  ).rejects.toThrow('Invalid normalized calculation identity');
  await expect(
    prepare({ declarations: [], requiredAliases: ['missing'] }),
  ).rejects.toThrow('Invalid normalized required alias');
});

it('rejects a symbol alias rather than silently dropping it', async () => {
  await expect(
    prepare({
      declarations: [],
      compute: {
        [Symbol('count')]: { sql: 'SELECT COUNT(*) FROM self.events' },
      },
    }),
  ).rejects.toBeInstanceOf(AnalyticalPreparationError);
});

it('keeps declared SQL and hidden column names out of request diagnostics', async () => {
  try {
    await prepare({
      declarations: [
        declared({
          sql: 'SELECT COUNT(secret_column) FROM self.hidden_association',
        }),
      ],
    });
    expect.fail('Expected invalid declaration');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalyticalPreparationError);
    expect(JSON.stringify(error)).not.toMatch(
      /secret_column|hidden_association|SELECT/,
    );
  }
});

it.each([
  { parameters: { missing: 'value' } },
  { parameters: { at: null } },
  { parameters: { at: 'not-a-timestamp' } },
  { parameters: { at: '2026-10-01T00:00:00.000Z', unused: 'value' } },
])(
  'validates caller parameters during preparation %#',
  async ({ parameters }) => {
    await expect(
      prepare({
        declarations: [],
        compute: {
          n: {
            sql: 'SELECT COUNT(*) FROM self.events WHERE at >= $at',
            parameters,
          },
        },
      }),
    ).rejects.toBeInstanceOf(AnalyticalPreparationError);
  },
);

it('rejects duplicate declarations before parsing', async () => {
  await expect(
    prepare({ declarations: [declared(), declared()] }),
  ).rejects.toThrow('Invalid normalized calculation declarations');
});
