/** Preserve the operation error even when SQLite auto-rolls back or cleanup fails. */
export function readTransaction<T>(
  db: { readonly isTransaction: boolean; exec(sql: string): void },
  operation: () => T,
): T {
  db.exec('BEGIN');
  let result: T;

  try {
    result = operation();
  } catch (error) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      // The original database error is the evidence the caller needs.
    }

    throw error;
  }

  if (db.isTransaction) db.exec('ROLLBACK');

  return result;
}
