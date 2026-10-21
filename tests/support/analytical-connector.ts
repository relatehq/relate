import type {
  AnalyticalConnection,
  AnalyticalResource,
  DatasetResource,
  DatasetSelection,
  PhysicalSchema,
} from 'relate/connectors';

/** Test-owned capability with no SQL execution; each test supplies its physical schema. */
export function createAnalyticalConnector(
  schema: PhysicalSchema,
  connectionId = 'analytics',
) {
  const resources = new Map<DatasetResource, DatasetSelection>();
  const described: DatasetResource[] = [];
  const connection: AnalyticalConnection = {
    connectionId,
    analytics: {
      limits: { maxParameters: 100 },
      async describe(resource, { signal }) {
        signal.throwIfAborted();

        if (!resources.has(resource)) throw new Error('Foreign resource');

        described.push(resource);

        return schema;
      },
      parameterBudget() {
        return { fixed: 0, perSlot: 1 };
      },
      plan() {
        throw new Error('Not an execution fixture');
      },
      async execute() {
        throw new Error('Not an execution fixture');
      },
    },
  };
  const table = (resourceId: string): AnalyticalResource => ({
    connection,
    resourceId,
    bindDataset(selection) {
      const resource = Object.freeze({}) as DatasetResource;

      resources.set(resource, selection);

      return resource;
    },
  });

  return { connection, table, described, resources };
}

export function analyticalGraphSchema(): PhysicalSchema {
  return {
    columns: {
      customerId: {
        supportedTypes: [{ type: 'string' }],
        nullable: false,
        databaseType: 'TEXT',
      },
      amount: {
        supportedTypes: [{ type: 'int64' }],
        nullable: false,
        databaseType: 'BIGINT',
      },
      secret: {
        supportedTypes: [{ type: 'string' }],
        nullable: false,
        databaseType: 'TEXT',
      },
    },
  };
}
