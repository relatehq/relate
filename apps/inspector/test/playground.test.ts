import { expect, it } from 'vitest';
import { checkCode, runDiagnostics } from '../src/playground/checks.js';
import { describeSql, suggest } from '../src/playground/completion.js';
import {
  datasetsOf,
  isFilterable,
  propertyType,
} from '../src/playground/model.js';
import { resultObjectOf } from '../src/playground/Results.js';
import {
  callContext,
  graphCalls,
  literalValue,
  objectAt,
  sqlTemplates,
} from '../src/playground/source.js';
import type { PlaygroundDiscovery } from '../src/protocol.js';

/** A principal's discovery: Customer and Invoice, optionally with Customer's events dataset. */
function createDiscovery(
  options: { readonly datasets?: boolean; readonly compute?: boolean } = {},
): PlaygroundDiscovery {
  const property = (
    name: string,
    type: string,
    extra: Record<string, unknown> = {},
  ) => ({
    definitionId: `customer.${name}`,
    name,
    kind: 'value',
    schema: { type, optional: false, nullable: false },
    filterOperators: ['eq', 'in'],
    ...extra,
  });

  return {
    principal: 'ana',
    runtimeId: 'runtime-1',
    definitionRevision: 'sha256:1',
    overview: {
      definitionId: 'workspace',
      definitionRevision: 'sha256:1',
      objects: { Customer: {}, Invoice: {} },
      sdk: {
        options: {
          select: {
            description: 'Properties to return.',
            operations: ['get', 'query'],
          },
          where: { description: 'Filters.', operations: ['query'] },
          limit: { description: 'Page size.', operations: ['query'] },
          ...(options.compute
            ? {
                compute: {
                  description: 'Computed fields.',
                  operations: ['get', 'query'],
                },
              }
            : {}),
        },
      },
    },
    objects: {
      Customer: {
        definitionId: 'business.customer',
        apiName: 'Customer',
        description: 'A paying customer.',
        properties: [
          property('name', 'string'),
          property('externalId', 'string'),
          property('customerSince', 'string', {
            schema: {
              type: 'string',
              format: 'timestamp',
              optional: false,
              nullable: false,
            },
          }),
        ],
        ...(options.datasets
          ? {
              datasets: {
                events: {
                  description: 'One row per recorded customer event.',
                  correlation: 'customerId = self.externalId',
                  columns: {
                    eventType: { type: 'string' },
                    occurredAt: { type: 'timestamp', precision: 3 },
                    userId: { type: 'string', nullable: true, readable: false },
                  },
                },
              },
            }
          : {}),
      },
      Invoice: {
        definitionId: 'billing.invoice',
        apiName: 'Invoice',
        properties: [property('number', 'string')],
      },
    },
  };
}

const at = (text: string, marker = '|') => ({
  text: text.replace(marker, ''),
  pos: text.indexOf(marker),
});

const labels = (result: ReturnType<typeof suggest>) =>
  result?.options.map((option) => option.label) ?? [];

it('reads literal graph calls, their options and SQL templates', () => {
  const text = `const page = await graph.objects.Customer.query({
  select: ['name'],
  compute: { logins: { sql: \`SELECT COUNT(*) FROM self.events AS e\`, parameters: { since: '2026-10-01' } } },
  limit: pageSize,
});
const one = await graph.objects.Invoice.get(id, { select: ['number'] });`;

  const calls = graphCalls(text);
  const [template] = sqlTemplates(text);

  expect(calls.map((c) => [c.object, c.operation])).toEqual([
    ['Customer', 'query'],
    ['Invoice', 'get'],
  ]);
  expect(literalValue(calls[1]!.options!)).toEqual({ select: ['number'] });
  // `limit` is a variable, so the options are not fully literal.
  expect(literalValue(calls[0]!.options!)).toBeUndefined();
  expect(text.slice(template!.contentFrom, template!.contentTo)).toBe(
    'SELECT COUNT(*) FROM self.events AS e',
  );
  expect(objectAt(text, text.indexOf('Invoice'))).toBe('Invoice');
});

it('keeps a half-typed call without arguments', () => {
  const [call] = graphCalls(`graph.objects.Customer.query({ select: ['na`);

  expect(call).toMatchObject({ object: 'Customer', args: null, options: null });
});

it('finds the option path at the cursor', () => {
  const { text, pos } = at(
    `graph.objects.Customer.query({ where: { name: { | } } })`,
  );

  expect(callContext(text, pos)).toMatchObject({
    call: { object: 'Customer', operation: 'query' },
    depth: 3,
    path: ['where', 'name'],
    container: '{',
    stringFrom: null,
  });
});

it('checks objects, options, select and filters against discovery', () => {
  const discovery = createDiscovery();
  const text = `await graph.objects.Custmer.query({});
await graph.objects.Customer.query({
  select: ['nme'],
  where: { name: { gt: 'A' }, region: 'EU' },
  limitt: 5,
  compute: {},
});`;

  const problems = checkCode(text, discovery).map((p) => ({
    text: text.slice(p.from, p.to),
    severity: p.severity,
    message: p.message,
    fix: p.fix?.insert,
  }));

  expect(problems).toEqual([
    {
      text: 'Custmer',
      severity: 'error',
      message: 'Unknown object Custmer. ana can use Customer, Invoice.',
      fix: 'Customer',
    },
    {
      text: 'limitt',
      severity: 'error',
      message:
        'Unknown option limitt. Customer.query accepts select, where, limit.',
      fix: 'limit',
    },
    {
      text: 'compute',
      severity: 'error',
      message:
        'compute is not supported by this runtime yet. Customer.query accepts select, where, limit.',
      fix: undefined,
    },
    {
      text: 'nme',
      severity: 'warning',
      message:
        'Customer has no property nme that ana can see; it comes back unavailable. Did you mean name?',
      fix: 'name',
    },
    {
      text: 'gt',
      severity: 'error',
      message: 'name does not support gt. Use eq, in.',
      fix: undefined,
    },
    {
      text: 'region',
      severity: 'error',
      message: 'Unknown filter field region on Customer.',
      fix: undefined,
    },
  ]);
});

it('accepts compute and filters on its aliases once discovery lists it', () => {
  const discovery = createDiscovery({ compute: true });
  const text = `graph.objects.Customer.query({
  compute: { logins: { sql: \`SELECT COUNT(*) FROM self.events\` } },
  where: { logins: { gte: '1' } },
});`;

  expect(checkCode(text, discovery)).toEqual([]);
});

it('warns about values interpolated into SQL', () => {
  const text =
    'graph.objects.Customer.query({ compute: { n: { sql: `SELECT COUNT(*) FROM self.events WHERE e.eventType = ${kind}` } } })';

  const [problem] = checkCode(text, null);

  expect(text.slice(problem!.from, problem!.to)).toBe('${kind}');
  expect(problem!.severity).toBe('warning');
});

it('places run issues on the code, inside SQL when the runtime gives a location', () => {
  const text = `graph.objects.Customer.query({
  where: { region: 'EU' },
  compute: {
    logins: {
      sql: \`SELECT COUNT(*) FROM self.events AS e
            WHERE e.occuredAt > $since\`,
    },
  },
});`;

  const sql = text.slice(
    sqlTemplates(text)[0]!.contentFrom,
    sqlTemplates(text)[0]!.contentTo,
  );
  const problems = runDiagnostics(text, [
    {
      operation: 'Customer.query',
      code: 'invalid-request',
      issues: [
        {
          path: ['where', 'region'],
          problem: 'unknown-property',
          message: 'Unknown region',
        },
        {
          path: ['compute', 'logins', 'sql'],
          problem: 'unknown-property',
          message: 'Unknown column occuredAt',
          location: {
            start: sql.indexOf('occuredAt'),
            end: sql.indexOf('occuredAt') + 9,
          },
        },
        {
          path: ['compute', 'logins', 'sql'],
          problem: 'unknown-property',
          message: 'Same, as line and column',
          location: {
            line: 2,
            column: sql.split('\n')[1]!.indexOf('occuredAt') + 1,
          },
        },
      ],
    },
  ]);

  expect(problems.map((p) => text.slice(p.from, p.to))).toEqual([
    'region',
    'occuredAt',
    'o',
  ]);
  expect(problems[0]!.message).toBe(
    'Unknown region (invalid-request from the last run)',
  );
});

it("suggests only the principal's objects, operations' options and properties", () => {
  const discovery = createDiscovery();
  const objects = at('graph.objects.|');
  const options = at(`graph.objects.Customer.query({ | })`);
  const select = at(`graph.objects.Customer.query({ select: ['|'] })`);
  const getOptions = at(`graph.objects.Customer.get(id, { | })`);

  expect(labels(suggest(objects.text, objects.pos, discovery))).toEqual([
    'Customer',
    'Invoice',
  ]);
  expect(labels(suggest(options.text, options.pos, discovery))).toEqual([
    'select',
    'where',
    'limit',
  ]);
  expect(labels(suggest(getOptions.text, getOptions.pos, discovery))).toEqual([
    'select',
  ]);
  expect(labels(suggest(select.text, select.pos, discovery))).toEqual([
    'name',
    'externalId',
    'customerSince',
  ]);
});

it('suggests datasets, columns, self properties and parameters inside SQL', () => {
  const discovery = createDiscovery({ datasets: true });
  const code = (sql: string) =>
    at(
      `graph.objects.Customer.query({ compute: { n: { sql: \`${sql}\`, parameters: { since: '2026-10-01T00:00:00Z' } } } })`,
    );
  const from = code('SELECT COUNT(*) FROM self.|');
  const columns = code('SELECT COUNT(*) FROM self.events AS e WHERE e.|');
  const self = code(
    'SELECT COUNT(*) FROM self.events AS e WHERE e.occurredAt > self.|',
  );
  const parameter = code(
    'SELECT COUNT(*) FROM self.events AS e WHERE e.occurredAt > $|',
  );
  const aggregate = code('SELECT |');

  expect(labels(suggest(from.text, from.pos, discovery))).toEqual(['events']);
  expect(suggest(columns.text, columns.pos, discovery)?.options).toEqual([
    expect.objectContaining({ label: 'eventType', detail: 'string' }),
    expect.objectContaining({ label: 'occurredAt', detail: 'timestamp' }),
    expect.objectContaining({
      label: 'userId',
      detail: 'string · forbidden for ana',
    }),
  ]);
  expect(labels(suggest(self.text, self.pos, discovery))).toEqual([
    'name',
    'externalId',
    'customerSince',
  ]);
  expect(labels(suggest(parameter.text, parameter.pos, discovery))).toEqual([
    '$since',
  ]);
  expect(
    labels(suggest(aggregate.text, aggregate.pos, discovery, true)),
  ).toContain('COUNT(*)');
});

it('offers no datasets until discovery reports them', () => {
  const discovery = createDiscovery();
  const from = at(
    'graph.objects.Customer.query({ compute: { n: { sql: `SELECT COUNT(*) FROM self.|` } } })',
  );

  expect(datasetsOf(discovery.objects.Customer)).toEqual([]);
  expect(labels(suggest(from.text, from.pos, discovery))).toEqual([
    'no datasets',
  ]);
});

it('describes a column under the cursor in SQL', () => {
  const discovery = createDiscovery({ datasets: true });
  const { text, pos } = at(
    'graph.objects.Customer.query({ compute: { n: { sql: `SELECT COUNT(*) FROM self.events AS e WHERE e.use|rId IS NULL` } } })',
  );

  expect(describeSql(text, pos, discovery)).toMatchObject({
    title: 'userId',
    detail: 'string?',
    note: 'Not readable as ana.',
  });
});

it('ignores graph calls in comments and strings', () => {
  const discovery = createDiscovery();
  const text = `// graph.objects.OldName.query({ limit: 5 })
/* graph.objects.Gone.query({}) */
const note = 'graph.objects.Nope.query({})';
const sql = \`not code: sql: \\\`x\\\`\`;
return graph.objects.Invoice.query({});`;

  expect(graphCalls(text).map((call) => call.object)).toEqual(['Invoice']);
  expect(checkCode(text, discovery)).toEqual([]);
  expect(objectAt(text, 0)).toBe('Invoice');
});

it('places the object span on the name, even when it occurs inside "objects"', () => {
  const text = 'graph.objects . s . query({})';
  const [call] = graphCalls(text);

  expect(text.slice(call!.objectSpan.from, call!.objectSpan.to)).toBe('s');
  expect(call!.objectSpan.from).toBe(text.indexOf(' s ') + 1);
});

it('counts SQL locations in the source as written, escapes included', () => {
  const text =
    "graph.objects.Customer.query({ compute: { n: { sql: `SELECT COUNT(*) FROM self.events AS e WHERE e.note = 'a\\\\b' AND e.occuredAt > $since` } } })";
  const template = sqlTemplates(text)[0]!;
  const sql = text.slice(template.contentFrom, template.contentTo);

  const [problem] = runDiagnostics(text, [
    {
      operation: 'Customer.query',
      code: 'invalid-request',
      issues: [
        {
          path: ['compute', 'n', 'sql'],
          problem: 'unknown-property',
          message: 'Unknown column',
          location: {
            start: sql.indexOf('occuredAt'),
            end: sql.indexOf('occuredAt') + 9,
          },
        },
      ],
    },
  ]);

  expect(text.slice(problem!.from, problem!.to)).toBe('occuredAt');
});

it('neither accepts nor offers a property discovery lists no filter operators for', () => {
  const discovery = createDiscovery();
  const customer = discovery.objects.Customer!;
  const withHidden = {
    ...discovery,
    objects: {
      ...discovery.objects,
      Customer: {
        ...customer,
        properties: [
          ...customer.properties,
          {
            definitionId: 'customer.notes',
            name: 'notes',
            kind: 'value',
            schema: { type: 'string', optional: false, nullable: false },
            filterOperators: [],
          },
        ],
      },
    },
  };
  const text = `graph.objects.Customer.query({ where: { notes: 'x' } })`;
  const keys = at(`graph.objects.Customer.query({ where: { | } })`);
  const operators = at(
    `graph.objects.Customer.query({ where: { notes: { | } } })`,
  );

  expect(checkCode(text, withHidden).map((p) => p.message)).toEqual([
    'notes is not a filterable property of Customer for ana.',
  ]);
  expect(labels(suggest(keys.text, keys.pos, withHidden))).not.toContain(
    'notes',
  );
  expect(labels(suggest(operators.text, operators.pos, withHidden))).toEqual(
    [],
  );
});

it('types result headers from the read that returned the records', () => {
  const run = {
    requestId: 'r1',
    principal: 'ana',
    status: 'succeeded' as const,
    result: { data: [{ id: 'a-1', data: {}, meta: {} }], meta: {} },
    logs: [],
    ms: 1,
    reads: [
      { object: 'Customer', operation: 'query' as const, ids: ['a-1'] },
      { object: 'Invoice', operation: 'query' as const, ids: ['i-1'] },
    ],
    errors: [],
  };

  expect(resultObjectOf(run)).toBe('Customer');
  expect(resultObjectOf({ ...run, reads: run.reads.slice(1) })).toBeNull();
});

it('uses explicit computed capabilities and logical types from runtime discovery', () => {
  const property = {
    definitionId: 'count',
    name: 'count',
    kind: 'computed',
    schema: { type: 'int64', nullable: false },
    readable: false,
    filterOperators: [],
  };

  expect(propertyType(property)).toBe('int64');
  expect(isFilterable(property)).toBe(false);
  expect(isFilterable({ ...property, filterOperators: ['eq', 'in'] })).toBe(
    true,
  );
  expect(
    propertyType({
      ...property,
      schema: { type: 'timestamp', precision: 6, nullable: true },
    }),
  ).toBe('timestamp?');
});
