import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { sqlite } from '@relate/connector-sqlite';
import {
  bind,
  computed,
  defineAccess,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { startApp } from '@relate/node';

it.each(['int32', 'int64'] as const)(
  'uses exact %s source correlations and self operands in public get/query reads',
  async (format) => {
    const directory = mkdtempSync(
      join(tmpdir(), 'relate-integer-correlation-'),
    );
    const path = join(directory, 'data.sqlite');
    const database = new DatabaseSync(path);
    const key = format === 'int64' ? '9007199254740993' : '2147483647';

    database.exec(`CREATE TABLE customers(id TEXT NOT NULL, external INTEGER NOT NULL, threshold INTEGER NOT NULL);
    INSERT INTO customers VALUES ('one', ${key}, 9007199254740992);
    CREATE TABLE events(customer INTEGER NOT NULL, amount INTEGER NOT NULL);
    INSERT INTO events VALUES (${key}, 9007199254740993), (${key}, 2), (${key} - 1, 9999999999999999);`);
    database.close();
    const connection = sqlite({ connectionId: 'integers', path });
    const access = defineAccess({
      roles: ['reader'],
      fieldGroups: ['ordinary'],
      claims: {},
    });
    const integer = format === 'int64' ? z.int64() : z.int32();
    const customers = defineSource({
      id: 'customers',
      idField: 'id',
      schema: z.object({
        id: z.string(),
        external: integer,
        threshold: z.int64(),
      }),
    });
    const Events = defineDataset({
      id: 'events',
      columns: {
        customer: {
          id: 'events.customer',
          schema: integer,
          access: access.groups.ordinary,
        },
        amount: {
          id: 'events.amount',
          schema: z.int64(),
          access: access.groups.ordinary,
        },
      },
    });
    const Customer = defineObject({
      id: 'customer',
      membership: source(customers),
      properties: {
        id: objectId({ id: 'customer.id' }),
        external: from(customers.fields.external, { id: 'customer.external' }),
        threshold: from(customers.fields.threshold, {
          id: 'customer.threshold',
        }),
        above: computed({
          id: 'customer.above',
          sql: 'SELECT COUNT(*) FROM self.events WHERE amount > self.threshold',
        }),
      },
      datasets: {
        events: {
          id: 'customer.events',
          dataset: Events,
          on: [{ column: 'customer', property: 'external' }],
        },
      },
    });
    const graph = defineGraph({
      id: 'integer-analytics',
      access,
      objects: { Customer },
      datasets: { Events },
      policies: {
        Customer: {
          read: { gate: access.role('reader') },
          datasets: { events: { gate: access.role('reader') } },
        },
        Events: {},
      },
    });
    const runtime = await startApp(
      defineApp({
        graph,
        setup: () => ({
          bindings: [
            bind(customers, connection.table('customers')),
            bind(Events, connection.table('events')),
          ],
        }),
      }),
    );

    try {
      const id = await runtime.host.adopt(Customer, 'one');
      const consumer = runtime.as({
        id: 'reader',
        roles: ['reader'],
        claims: {},
      }).objects.Customer;
      const result = await consumer.get(id, {
        select: ['external', 'threshold', 'above'],
        evidence: 'full',
      });

      expect(result).toMatchObject({
        status: 'ok',
        data: {
          external: format === 'int64' ? key : Number(key),
          threshold: '9007199254740992',
          above: '1',
        },
        meta: {
          fields: {
            above: {
              dependencies: {
                external: { source: 'source', status: 'available' },
                threshold: { source: 'source', status: 'available' },
              },
            },
          },
        },
      });
      const page = await consumer.query({
        select: ['above'],
        where: { threshold: { gt: '20' } },
        compute: { total: { sql: 'SELECT SUM(amount) FROM self.events' } },
      });

      expect(page.data.map((row) => row.data)).toEqual([
        { above: '1', total: '9007199254740995' },
      ]);
      expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    } finally {
      await runtime.close();
      await connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
