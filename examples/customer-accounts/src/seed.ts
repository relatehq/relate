import { DatabaseSync } from 'node:sqlite';

/** Demo provider data. Application startup only opens this database read-only. */
export function seed(path: string): void {
  const db = new DatabaseSync(path);

  try {
    db.exec(`
      CREATE TABLE customers (
        id TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        portfolio TEXT NOT NULL,
        stripe_customer_id TEXT
      );
      INSERT INTO customers VALUES
        ('crm_northwind', 'Northwind', 'portfolio_north', 'cus_demo_northwind'),
        ('crm_south', 'South Coast', 'portfolio_south', NULL);
    `);
  } finally {
    db.close();
  }
}
