import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { onTestFinished } from 'vitest';
import { sqliteBackend, postgresBackend } from '../backends.js';
import { quote } from '../generate.js';
import type { Association, Candidate, Expression } from '../contracts.js';

export function association(table = 'events'): Association {
  return {
    name: 'events',
    table,
    columns: {
      customerId: { physical: 'customer_id', type: 'string', readable: true },
      eventType: { physical: 'event_type', type: 'string', readable: true },
      occurredAt: {
        physical: 'occurred_at',
        type: 'timestamp',
        readable: true,
      },
      userId: { physical: 'user_id', type: 'string', readable: false },
      amount: { physical: 'amount', type: 'int64', readable: true },
    },
    properties: {
      externalId: { type: 'string', readable: true },
      customerSince: { type: 'timestamp', readable: true },
      name: { type: 'string', readable: true },
    },
    on: { customerId: 'externalId' },
  };
}

export function customers(): Candidate[] {
  return [
    {
      id: 'acme',
      properties: {
        externalId: 'crm_acme',
        customerSince: '2026-09-30T00:00:00.000Z',
      },
    },
    {
      id: 'globex',
      properties: {
        externalId: 'crm_globex',
        customerSince: '2026-10-01T00:00:00.000Z',
      },
    },
    {
      id: 'initech',
      properties: {
        externalId: 'crm_initech',
        customerSince: '2026-01-15T00:00:00.000Z',
      },
    },
  ];
}

export function expressions(): Record<string, Expression> {
  return {
    loginsOct: {
      sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login' AND e.occurredAt >= $since AND e.occurredAt < $until",
      parameters: {
        since: '2026-10-01T00:00:00Z',
        until: '2026-11-01T00:00:00Z',
      },
    },
    lastLogin: {
      sql: "SELECT MAX(e.occurredAt) FROM self.events e WHERE e.eventType = 'login'",
    },
  };
}

function events() {
  return [
    [
      'crm_acme',
      'login',
      '2026-09-28T08:00:00.000Z',
      'u_1',
      '9007199254740993',
    ],
    ['crm_acme', 'login', '2026-10-02T09:00:00.000Z', 'u_1', '2'],
    ['crm_acme', 'login', '2026-10-09T10:30:00.000Z', 'u_2', '3'],
    ['crm_acme', 'page_view', '2026-10-09T10:31:00.000Z', null, '4'],
    ['crm_globex', 'login', '2026-10-03T14:00:00.000Z', 'u_7', '5'],
    ['crm_umbrella', 'login', '2026-10-04T11:00:00.000Z', 'u_9', '6'],
  ];
}

export async function fixture(dialect: 'postgres' | 'sqlite') {
  if (dialect === 'sqlite') {
    const directory = mkdtempSync(join(tmpdir(), 'relate-analytical-'));
    const path = join(directory, 'events.db');

    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const db = new DatabaseSync(path);

    try {
      db.exec(
        'CREATE TABLE events(customer_id TEXT, event_type TEXT, occurred_at TEXT, user_id TEXT, amount INTEGER)',
      );
      const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)');

      for (const row of events())
        insert.run(...row.slice(0, 4), BigInt(row[4]!));
    } finally {
      db.close();
    }

    return { backend: sqliteBackend(path), association: association(), path };
  }

  const connectionString = process.env.RELATE_TEST_DATABASE_URL;

  if (!connectionString)
    throw new Error(
      'RELATE_TEST_DATABASE_URL is required; use the worktree .env',
    );

  const table = `analytical_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString });

  await client.connect();
  onTestFinished(async () => {
    await client.query(`DROP TABLE IF EXISTS ${quote(table)}`);
    await client.end();
  });
  await client.query(
    `CREATE TABLE ${quote(table)}(customer_id text, event_type text, occurred_at timestamptz, user_id text, amount bigint)`,
  );

  for (const row of events())
    await client.query(
      `INSERT INTO ${quote(table)} VALUES ($1, $2, $3, $4, $5)`,
      row,
    );

  return {
    backend: postgresBackend(connectionString),
    association: association(table),
  };
}
