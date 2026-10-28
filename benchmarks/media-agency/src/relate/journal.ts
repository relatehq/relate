import { DatabaseSync } from 'node:sqlite';

/** Outside Relate's transaction: an external commit survives local rollback. */
export class Journal {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, value TEXT)',
    );
  }
  async once<T>(
    id: string,
    write: () => Promise<T>,
    recover: () => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const previous = this.db
      .prepare('SELECT value FROM operations WHERE id = ?')
      .get(id);

    if (previous?.value) return JSON.parse(String(previous.value)) as T;

    if (!previous) {
      this.db.prepare('INSERT INTO operations VALUES (?, NULL)').run(id);

      try {
        const value = await write();

        this.db
          .prepare('UPDATE operations SET value = ? WHERE id = ?')
          .run(JSON.stringify(value), id);

        return value;
      } catch {
        /* An exception does not prove that the provider did not commit. */
      }
    }

    const value = await recover();

    if (value !== undefined)
      this.db
        .prepare('UPDATE operations SET value = ? WHERE id = ?')
        .run(JSON.stringify(value), id);

    return value;
  }
  close() {
    this.db.close();
  }
}
