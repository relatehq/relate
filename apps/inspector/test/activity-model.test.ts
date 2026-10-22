import { expect, it } from 'vitest';
import {
  describeRequest,
  facet,
  flattenFields,
  histogram,
  matches,
  operationOmitted,
  parseDuration,
  parseQuery,
  requestFacts,
  timeline,
  touchedObjects,
} from '../src/activity/model.js';
import type { RequestActivity } from '../src/connection/activity.js';
import type { CallEvent, OperationEvent } from '../src/protocol.js';

const at = (ms: number) =>
  new Date(Date.UTC(2026, 9, 22, 10) + ms).toISOString();

function createCall(overrides: Partial<CallEvent> = {}): CallEvent {
  return {
    kind: 'call',
    requestId: 'request-1',
    runtimeId: 'runtime-1',
    source: 'inspector-agent',
    principal: 'ops@acme.com',
    tool: 'execute',
    at: at(0),
    status: 'succeeded',
    ms: 120,
    ...overrides,
  };
}

function createOperation(
  overrides: Partial<OperationEvent> = {},
): OperationEvent {
  return {
    kind: 'operation',
    opId: 'operation-1',
    context: {
      requestId: 'request-1',
      runtimeId: 'runtime-1',
      definitionRevision: 'revision-1',
      principal: 'ops@acme.com',
      transport: 'mcp',
    },
    at: at(10),
    op: 'query',
    definitionId: 'customer',
    request: {},
    status: 'succeeded',
    recordIds: [],
    ms: 30,
    ...overrides,
  };
}

function createRequest(
  operations: readonly OperationEvent[],
  call: CallEvent | null = createCall(),
): RequestActivity {
  return {
    requestId: 'request-1',
    call: call ?? undefined,
    execution: undefined,
    operations,
  };
}

it('parses keys, aliases, comparisons, negation, lists and free text', () => {
  const tokens = parseQuery(
    'who:ops status:failed -source:agent op:query,traverse duration>=1.5s "late invoice" refund',
  );

  expect(
    tokens.map(({ key, negated, comparator, values }) => ({
      key,
      negated,
      comparator,
      values,
    })),
  ).toEqual([
    { key: 'principal', negated: false, comparator: ':', values: ['ops'] },
    { key: 'status', negated: false, comparator: ':', values: ['failed'] },
    { key: 'source', negated: true, comparator: ':', values: ['agent'] },
    {
      key: 'op',
      negated: false,
      comparator: ':',
      values: ['query', 'traverse'],
    },
    { key: 'duration', negated: false, comparator: '>=', values: ['1.5s'] },
    { key: 'text', negated: false, comparator: ':', values: ['late invoice'] },
    { key: 'text', negated: false, comparator: ':', values: ['refund'] },
  ]);
  expect(parseDuration('250')).toBe(250);
  expect(parseDuration('2m')).toBe(120_000);
  expect(parseDuration('fast')).toBeUndefined();
});

it('matches a request on any of its operations and on its elapsed time', () => {
  const request = describeRequest(
    createRequest([
      createOperation({ recordIds: ['cus_1'] }),
      createOperation({
        opId: 'operation-2',
        op: 'updated',
        definitionId: 'invoice',
        recordIds: ['inv_7'],
        runtime: {
          record: 'committed',
          actor: { kind: 'source', id: 'billing' },
          changedPropertyIds: ['invoice.status'],
        },
      }),
    ]),
  );
  const labels = new Map([['invoice', 'Invoice']]);
  const facts = requestFacts(request, labels);

  expect(matches(parseQuery('def:Invoice object:inv_7'), facts)).toBe(true);
  expect(matches(parseQuery('record:committed principal:billing'), facts)).toBe(
    true,
  );
  expect(matches(parseQuery('duration>100ms source:agent'), facts)).toBe(true);
  expect(matches(parseQuery('duration>200ms'), facts)).toBe(false);
  expect(matches(parseQuery('-def:invoice'), facts)).toBe(false);
  expect(matches(parseQuery('analytical:true'), facts)).toBe(false);
});

it('derives timing and status from the operations when a request has no call', () => {
  const request = describeRequest(
    createRequest(
      [
        createOperation({ at: at(0), ms: 5 }),
        createOperation({ opId: 'operation-2', at: at(20), ms: 15 }),
      ],
      null,
    ),
  );

  expect(request.ms).toBe(35);
  expect(request.status).toBe('succeeded');
  expect(request.source).toBe('mcp');
  expect(request.tool).toBe('mcp');
  expect(request.principal).toBe('ops@acme.com');
});

it('nests refreshes under the operation that triggered them, in start order', () => {
  const request = describeRequest(
    createRequest([
      createOperation({ opId: 'read', at: at(10) }),
      createOperation({ opId: 'second', at: at(60) }),
      createOperation({
        opId: 'refresh',
        op: 'refresh',
        at: at(12),
        runtime: {
          record: 'attempt',
          actor: { kind: 'system', id: 'runtime' },
          parentOperationId: 'read',
        },
      }),
    ]),
  );

  expect(
    timeline(request).map((entry) => [
      entry.operation.opId,
      entry.depth,
      entry.offset,
    ]),
  ).toEqual([
    ['read', 0, 10],
    ['refresh', 1, 12],
    ['second', 0, 60],
  ]);
});

it('groups touched records by definition with committed property changes and refusals', () => {
  const touched = touchedObjects(
    [
      createOperation({
        recordIds: ['cus_1', 'cus_2'],
        runtime: {
          record: 'attempt',
          actor: { kind: 'principal', id: 'ops@acme.com' },
          forbidden: ['customer.email'],
          omittedObjects: 3,
        },
      }),
      createOperation({
        opId: 'operation-2',
        op: 'updated',
        recordIds: ['cus_1'],
        runtime: {
          record: 'committed',
          actor: { kind: 'principal', id: 'ops@acme.com' },
          changedPropertyIds: ['customer.plan'],
        },
      }),
      createOperation({
        opId: 'operation-3',
        op: 'invoke',
        definitionId: 'openAccountReview',
      }),
    ],
    2,
  );

  expect(touched).toEqual([
    {
      definitionId: 'customer',
      action: false,
      operations: 2,
      records: [
        { id: 'cus_1', ops: ['query', 'updated'], changed: ['customer.plan'] },
        { id: 'cus_2', ops: ['query'], changed: [] },
      ],
      changes: 1,
      forbidden: ['customer.email'],
      omitted: 3,
      capped: true,
    },
    {
      definitionId: 'openAccountReview',
      action: true,
      operations: 1,
      records: [],
      changes: 0,
      forbidden: [],
      omitted: 0,
      capped: false,
    },
  ]);
});

it('buckets failed and successful items across the range and counts facets', () => {
  const buckets = histogram(
    [
      { at: 0, failed: false },
      { at: 5, failed: true },
      { at: 99, failed: false },
      { at: 200, failed: false },
    ],
    0,
    100,
    2,
  );

  expect(buckets).toEqual([
    { from: 0, ok: 1, failed: 1 },
    { from: 50, ok: 1, failed: 0 },
  ]);
  expect(facet([['a', 'b'], ['a'], ['a', 'a']], (values) => values)).toEqual([
    { value: 'a', label: 'a', count: 3 },
    { value: 'b', label: 'b', count: 1 },
  ]);
});

it('flattens every recorded field except those shown on their own tab', () => {
  const fields = flattenFields(
    createOperation({
      request: { select: ['name', 'plan'], limit: 20 },
      recordIds: ['cus_1'],
      runtime: {
        record: 'attempt',
        actor: { kind: 'principal', id: 'ops@acme.com' },
        analytical: {
          stages: { execution: { count: 1, totalMs: 2, maxMs: 2 } },
        },
      },
    }),
    operationOmitted,
  );

  expect(fields).toContainEqual(['context.transport', 'mcp']);
  expect(fields).toContainEqual(['request.select', 'name, plan']);
  expect(fields).toContainEqual(['request.limit', '20']);
  expect(fields).toContainEqual(['runtime.actor.id', 'ops@acme.com']);
  expect(fields.some(([key]) => key.startsWith('runtime.analytical'))).toBe(
    false,
  );
  expect(fields.some(([key]) => key === 'recordIds')).toBe(false);
});
