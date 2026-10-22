import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqlite } from '@relate/connector-sqlite';
import { bind, defineApp } from 'relate';
import type { AppSetupContext } from 'relate';
import { crmCustomers, Events, graph, declaredGraph } from './graph.js';
import { customers, events } from './data.js';

/** Startup owns one temporary SQLite file; importing the model opens nothing. */
async function setup({ onDispose }: AppSetupContext) {
  const directory = await mkdtemp(join(tmpdir(), 'relate-customer-events-'));

  onDispose(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'crm.sqlite');
  const db = new DatabaseSync(path);

  try {
    db.exec(`
      CREATE TABLE customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, portfolio TEXT NOT NULL, customer_since TEXT NOT NULL);
      CREATE TABLE events(customer_id TEXT NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, user_id TEXT);
      CREATE INDEX events_by_customer ON events(customer_id, event_type, occurred_at);
    `);
    const insertCustomer = db.prepare(
      'INSERT INTO customers VALUES (?, ?, ?, ?)',
    );

    for (const row of customers) insertCustomer.run(...row);

    const insertEvent = db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');

    for (const row of events) insertEvent.run(...row);
  } finally {
    db.close();
  }

  const connection = sqlite({ connectionId: 'example-crm', path });

  onDispose(() => connection.close());

  return {
    bindings: [
      bind(crmCustomers, connection.table('customers')),
      bind(Events, connection.table('events'), {
        columns: {
          customerId: 'customer_id',
          eventType: 'event_type',
          occurredAt: 'occurred_at',
          userId: 'user_id',
        },
      }),
    ],
  };
}

export const app = defineApp({ graph, setup });
export const declaredApp = defineApp({ graph: declaredGraph, setup });
