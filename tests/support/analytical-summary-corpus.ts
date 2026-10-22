/** Identical trust-boundary cases for persisted host rows and Inspector wire data. */
export function analyticalSummaryCorpus() {
  const calculation = {
    associationId: 'customer.events',
    datasetId: 'events',
    propertyId: 'customer.total',
    failures: { 'invalid-result': 2 },
  };
  const valid = {
    expressionCount: 1,
    computedFilter: true,
    computedOrder: false,
    calculations: [calculation],
  };
  const entry = (change: Record<string, unknown>) => ({
    ...valid,
    calculations: [{ ...calculation, ...change }],
  });

  return {
    valid,
    invalid: [
      { ...valid, expressionCount: 0 },
      { ...valid, expressionCount: Infinity },
      { ...valid, computedFilter: 'true' },
      { ...valid, computedOrder: undefined },
      { ...valid, sql: 'private SQL' },
      { ...valid, expressionCount: 2, omittedCalculations: 0 },
      {
        ...valid,
        expressionCount: 33,
        calculations: Array.from({ length: 33 }, () => calculation),
      },
      entry({ associationId: '' }),
      entry({ associationId: '  ' }),
      entry({ datasetId: 'é'.repeat(129) }),
      entry({ propertyId: 'x'.repeat(257) }),
      entry({ alias: 'privateAlias' }),
      entry({ parameters: { secret: 'private' } }),
      entry({ failures: { 'private-driver-error': 1 } }),
      entry({ failures: { busy: 0 } }),
      entry({ failures: { busy: 0.5 } }),
      entry({ failures: { busy: Number.MAX_SAFE_INTEGER + 1 } }),
    ],
  };
}
