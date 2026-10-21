import { expect, it } from 'vitest';
import { analyticalSummaryLimits } from '@relate/protocol';
import {
  createCalculationSummary,
  captureCalculations,
} from '../src/analytics/activity.js';
import type { ResolvedCalculation } from '../src/analytics/execution-types.js';

function field(
  name: string,
  propertyId?: string,
  associationId = 'customer.events',
): ResolvedCalculation {
  // The capture reads only identities; executable SQL/value state is deliberately irrelevant.
  return {
    name,
    ...(propertyId ? { definitionId: propertyId } : {}),
    expression: {
      association: { id: associationId, datasetDefinitionId: 'events' },
      sql: 'PRIVATE SQL',
      parameters: { secret: 'PRIVATE PARAMETER' },
    },
  } as unknown as ResolvedCalculation;
}

it('captures one identity per expression, omits aliases and snapshots failure counts without double-counting revalidation', () => {
  const capture = createCalculationSummary({
    computedFilter: true,
    computedOrder: false,
  });

  expect(capture.snapshot()).toBeUndefined();
  capture.prepared([
    field('privateAlias'),
    field('declared', 'customer.total'),
  ]);
  const initial = {
    privateAlias: { status: 'available' },
    declared: { status: 'unavailable', reason: 'busy' },
  };
  const changed = {
    privateAlias: { status: 'forbidden' },
    declared: initial.declared,
  };

  capture.results(initial);
  capture.results(changed, initial);
  capture.results(changed, changed);
  const summary = capture.snapshot()!;

  expect(summary).toEqual({
    expressionCount: 2,
    computedFilter: true,
    computedOrder: false,
    calculations: [
      {
        associationId: 'customer.events',
        datasetId: 'events',
        failures: { forbidden: 1 },
      },
      {
        associationId: 'customer.events',
        datasetId: 'events',
        propertyId: 'customer.total',
        failures: { busy: 1 },
      },
    ],
  });
  capture.results({
    privateAlias: { status: 'unavailable', reason: 'invalid-result' },
  });
  expect(summary.calculations[0]!.failures).toEqual({ forbidden: 1 });
  expect(capture.snapshot()!.calculations[0]!.failures).toEqual({
    forbidden: 1,
    'invalid-result': 1,
  });
  expect(JSON.stringify(summary)).not.toMatch(
    /privateAlias|PRIVATE|parameters|sql/,
  );
});

it('bounds entries and UTF-8 identifiers without shortening stable IDs or retaining extra aliases', () => {
  const capture = createCalculationSummary({
    computedFilter: false,
    computedOrder: true,
  });

  capture.prepared([
    field('oversized', undefined, 'é'.repeat(129)),
    ...Array.from(
      { length: analyticalSummaryLimits.maxCalculations + 5 },
      (_, index) => field(`alias${index}`),
    ),
  ]);
  const summary = capture.snapshot()!;

  expect(summary.expressionCount).toBe(38);
  expect(summary.calculations).toHaveLength(32);
  expect(summary.omittedCalculations).toBe(6);
  expect(JSON.stringify(summary)).not.toMatch(/oversized|alias|é/);
  capture.prepared([field('replacement')]);
  expect(capture.snapshot()).toEqual(summary);
});

it('counts pending results as interrupted only after execution is interrupted', () => {
  const capture = createCalculationSummary({
    computedFilter: false,
    computedOrder: false,
  });

  capture.prepared([field('value')]);
  capture.results({ value: { status: 'pending' } });
  expect(capture.snapshot()!.calculations[0]!.failures).toEqual({});
  capture.results({ value: { status: 'pending' } }, undefined, true);
  expect(capture.snapshot()!.calculations[0]!.failures).toEqual({
    interrupted: 1,
  });
});

it('isolates failed diagnostic observers, including asynchronous rejection', async () => {
  const capture = {
    prepared() {
      throw new Error('broken');
    },
    results() {
      return Promise.reject(new Error('broken async'));
    },
  };

  expect(() =>
    captureCalculations(capture, (value) => value.prepared([])),
  ).not.toThrow();
  expect(() =>
    captureCalculations(capture, (value) => value.results({})),
  ).not.toThrow();
  captureCalculations(undefined, () => {
    throw new Error('disabled');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
