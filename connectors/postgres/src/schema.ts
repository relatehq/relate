import type { PhysicalColumn, PhysicalSchema } from 'relate/connectors';
import type { StatementClient } from './client.js';
import type { SelectedDataset } from './plan.js';

export async function describe(
  client: StatementClient,
  resource: SelectedDataset,
): Promise<PhysicalSchema> {
  const rows = await client.query(
    `SELECT a.attname, a.atttypid::pg_catalog.text, a.atttypmod::pg_catalog.text, a.attnotnull::pg_catalog.text,
    pg_catalog.format_type(a.atttypid, a.atttypmod)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname OPERATOR(pg_catalog.=) $1::pg_catalog.text AND c.relname OPERATOR(pg_catalog.=) $2::pg_catalog.text
      AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [resource.schema, resource.table],
  );

  if (!rows.length) throw new Error('Missing analytical table');

  const columns: Record<string, PhysicalColumn> = {};

  for (const [declared, physical] of Object.entries(resource.columns)) {
    const row = rows.find((row) => row[0] === physical);

    if (!row) continue;

    const oid = Number(row[1]),
      modifier = Number(row[2]);
    const precision = modifier < 0 ? 6 : modifier;
    const supportedTypes: PhysicalColumn['supportedTypes'] =
      oid === 16
        ? [{ type: 'boolean' }]
        : oid === 25 || oid === 1043
          ? [{ type: 'string' }]
          : oid === 23
            ? [{ type: 'int32' }]
            : oid === 20
              ? [{ type: 'int64' }]
              : oid === 701
                ? [{ type: 'float64' }]
                : oid === 1184 && (precision === 3 || precision === 6)
                  ? [{ type: 'timestamp', precision }]
                  : [];

    Object.defineProperty(columns, declared, {
      enumerable: true,
      value: {
        supportedTypes,
        nullable: row[3] !== 'true',
        databaseType: row[4]!,
      },
    });
  }

  return { columns };
}
