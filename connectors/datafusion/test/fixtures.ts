import type {
  AuthorizedDatasetQuery,
  ResolvedAggregate,
  ResolvedAggregateLeaf,
  ResolvedOperand,
  TypedValue,
} from 'relate/connectors';

export const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 2000,
});

export function column(
  column: string,
  type: TypedValue['type'],
  precision: 3 | 6 = 3,
): ResolvedOperand {
  return {
    kind: 'column',
    column,
    type: type === 'timestamp' ? { type, precision } : { type },
  };
}

export function aggregate(
  name: ResolvedAggregateLeaf['aggregate'],
  argument: ResolvedOperand | '*',
  type: TypedValue['type'],
  precision: 3 | 6 = 3,
): ResolvedAggregateLeaf {
  return {
    aggregate: name,
    argument,
    distinct: false,
    result: {
      ...(type === 'timestamp' ? { type, precision } : { type }),
      nullable: name !== 'count',
    },
  };
}

export function query(
  resource: AuthorizedDatasetQuery['resource'],
  aggregates: readonly ResolvedAggregate[],
  customers = ['acme', 'empty', 'nulls'],
): AuthorizedDatasetQuery {
  return {
    resource,
    keys: [{ type: { type: 'string' } }],
    correlation: [{ column: 'customerId', key: 0 }],
    aggregates,
    slots: customers.map((value) => ({
      values: [{ type: 'string', value }],
      valid: aggregates.map(() => true),
    })),
  };
}
