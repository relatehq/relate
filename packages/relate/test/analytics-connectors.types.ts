import type {
  AnalyticalConnector,
  AuthorizedDatasetQuery,
  DatasetResource,
  PhysicalSchema,
  PreparedPlan,
  SlotRow,
} from 'relate/connectors';

// Public handles cannot be confused, forged structurally, or replaced by SQL.
export function useOpaqueHandles(
  resource: DatasetResource,
  plan: PreparedPlan,
) {
  // @ts-expect-error dataset resources and plans are distinct opaque identities
  const wrongResource: DatasetResource = plan;
  // @ts-expect-error dataset resources cannot execute as plans
  const wrongPlan: PreparedPlan = resource;
  // @ts-expect-error a raw SQL query is not a plan
  const sql: PreparedPlan = { sql: 'SELECT 1' };
  // @ts-expect-error physical table names are not resource handles
  const table: DatasetResource = { table: 'events' };

  return [wrongResource, wrongPlan, sql, table];
}

export function consumeConnector(
  connector: AnalyticalConnector,
  query: AuthorizedDatasetQuery,
) {
  const plan = connector.plan(query);
  const exact: PreparedPlan = plan;

  // @ts-expect-error analytical capabilities do not own connection disposal
  connector.close();
  // @ts-expect-error physical SQL cannot cross the planning boundary
  plan.sql;

  return exact;
}

export const portableRows: SlotRow[] = [
  {
    slot: 0,
    values: [1n, 1, '2026-01-01T00:00:00.123456Z', true, null],
  },
];

// @ts-expect-error driver Date objects cannot cross the execution boundary
export const driverRows: SlotRow[] = [{ slot: 0, values: [new Date()] }];

export const physical: PhysicalSchema = {
  columns: {
    // SQLite INTEGER can represent these logical declarations.
    customerId: {
      databaseType: 'INTEGER',
      nullable: false,
      supportedTypes: [{ type: 'int32' }, { type: 'int64' }],
    },
    // Unsupported physical types provide diagnostics but no compatibility claim.
    localTime: {
      databaseType: 'TIMESTAMP WITHOUT TIME ZONE',
      nullable: true,
      supportedTypes: [],
    },
  },
};
