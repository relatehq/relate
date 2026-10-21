import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  AnalyticalTimings,
  AnalyticalSummary,
} from '../src/screens/ActivityScreen.js';
import { analyticalSummarySchema } from '../src/protocol.js';
import { analyticalSummaryCorpus } from '../../../tests/support/analytical-summary-corpus.js';
import type { OperationEvent } from '../src/protocol.js';

function createOperation(
  analytical?: NonNullable<OperationEvent['runtime']>['analytical'],
): OperationEvent {
  return {
    kind: 'operation',
    opId: 'operation-1',
    context: {
      requestId: 'request-1',
      definitionRevision: 'revision-1',
      principal: 'alice',
      transport: 'embedded',
    },
    at: '2026-10-21T10:00:00.000Z',
    op: 'query',
    definitionId: 'customer',
    request: {},
    status: 'succeeded',
    recordIds: [],
    ms: 10,
    ...(analytical
      ? {
          runtime: {
            record: 'attempt',
            actor: { kind: 'principal', id: 'alice' },
            analytical,
          },
        }
      : {}),
  };
}

it('renders summed stage work beside elapsed time without inventing unentered stages', () => {
  const operation = createOperation({
    stages: {
      dependencyReads: { count: 2, totalMs: 15, maxMs: 9 },
      execution: { count: 1, totalMs: 4.5, maxMs: 4.5 },
    },
  });
  const html = renderToStaticMarkup(
    createElement(AnalyticalTimings, { operation }),
  );

  expect(html).toContain('Elapsed: 10 ms');
  expect(html).toContain('Summed work durations overlap');
  expect(html).toContain('15.00 ms');
  expect(html).toContain('4.50 ms');
  expect(html).toContain('Dependency reads');
  expect(html).not.toContain('Connection startup');
  expect(
    renderToStaticMarkup(
      createElement(AnalyticalTimings, { operation: createOperation() }),
    ),
  ).toBe('');
});

it('renders bounded calculation identities and failure counts without presenting caller aliases', () => {
  const { valid, invalid } = analyticalSummaryCorpus();

  expect(analyticalSummarySchema.parse(valid)).toEqual(valid);

  for (const value of invalid)
    expect(analyticalSummarySchema.safeParse(value).success).toBe(false);

  const operation = createOperation({
    stages: {},
    summary: {
      ...valid,
      expressionCount: 3,
      computedOrder: true,
      omittedCalculations: 1,
      calculations: [
        ...valid.calculations,
        {
          associationId: 'customer.events',
          datasetId: 'events',
          failures: {},
        },
      ],
    },
  });
  const html = renderToStaticMarkup(
    createElement(AnalyticalSummary, { operation }),
  );

  for (const text of [
    '3 expressions',
    'Computed filter',
    'Computed order',
    'customer.total',
    'Caller expression',
    'customer.events',
    'Dataset: events',
    'invalid-result',
    'Repeated checks count once',
    '1 expression entry omitted',
  ])
    expect(html).toContain(text);

  expect(
    renderToStaticMarkup(
      createElement(AnalyticalSummary, { operation: createOperation() }),
    ),
  ).toBe('');
});
