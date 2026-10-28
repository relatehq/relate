import type { DuckDBConnection } from '@duckdb/node-api';
import type { PhysicalColumn, PhysicalSchema } from 'relate/connectors';
import type { SelectedDataset } from './plan.js';
import { identifier } from './identifiers.js';

export async function describe(
  connection: DuckDBConnection,
  resource: SelectedDataset,
): Promise<PhysicalSchema> {
  const reader = await connection.runAndReadAll(
    `DESCRIBE SELECT * FROM ${identifier(resource.schema)}.${identifier(resource.table)}`,
  );
  const rows = reader.getRows();
  const columns: Record<string, PhysicalColumn> = {};

  for (const [declared, physical] of Object.entries(resource.columns)) {
    const row = rows.find(
      (row) =>
        typeof row[0] === 'string' &&
        row[0].toLowerCase() === physical.toLowerCase(),
    );

    if (!row) continue;

    const databaseType = String(row[1]);
    const supportedTypes: PhysicalColumn['supportedTypes'] =
      databaseType === 'BOOLEAN'
        ? [{ type: 'boolean' }]
        : databaseType === 'VARCHAR'
          ? [{ type: 'string' }]
          : databaseType === 'INTEGER'
            ? [{ type: 'int32' }]
            : databaseType === 'BIGINT'
              ? [{ type: 'int64' }]
              : databaseType === 'DOUBLE'
                ? [{ type: 'float64' }]
                : databaseType === 'TIMESTAMP_MS'
                  ? [{ type: 'timestamp', precision: 3 }]
                  : databaseType === 'TIMESTAMP'
                    ? [{ type: 'timestamp', precision: 6 }]
                    : databaseType === 'DATE'
                      ? [{ type: 'date' }]
                      : [];

    Object.defineProperty(columns, declared, {
      enumerable: true,
      value: {
        supportedTypes,
        nullable: row[2] !== 'NO',
        databaseType,
      },
    });
  }

  return { columns };
}
