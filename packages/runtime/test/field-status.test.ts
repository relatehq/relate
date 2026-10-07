import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  defineSource,
  from,
  native,
  nativeMembership,
  objectId,
  source,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import { ReadError } from '@relate/protocol';

const access = defineAccess({
  roles: ['employee', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: { portfolio: z.string() },
});
const records = defineSource({
  id: 'records',
  idField: 'id',
  schema: z.object({ id: z.string(), name: z.string(), revenue: z.number() }),
});
const Customer = defineObject({
  id: 'customer',
  membership: source(records),
  properties: {
    id: objectId({ id: 'customer.id' }),
    name: from(records.fields.name, { id: 'customer.name' }),
    revenue: from(records.fields.revenue, {
      id: 'customer.revenue',
      access: access.groups.financial,
    }),
  },
});
const Note = defineObject({
  id: 'note',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'note.id' }),
    body: native(z.string(), { id: 'note.body' }),
    amount: native(z.number(), {
      id: 'note.amount',
      access: access.groups.financial,
    }),
  },
});
const AddNote = defineAction({
  id: 'add-note',
  input: z.object({ body: z.string(), amount: z.number() }),
  output: z.object({ noteId: z.string() }),
  creates: [Note],
  policy: { execute: access.role('finance') },
});
const graph = defineGraph({
  id: 'field-status',
  access,
  objects: { Customer, Note },
  actions: { addNote: AddNote },
  policies: {
    Customer: {
      read: { gate: access.role('employee') },
      groups: { financial: access.role('finance') },
    },
    Note: {
      read: { gate: access.role('employee') },
      create: { gate: access.role('finance') },
      groups: { financial: access.role('finance') },
    },
  },
});
const employee = { id: 'ana', roles: ['employee'], claims: {} };
const finance = { id: 'fin', roles: ['employee', 'finance'], claims: {} };

function fixture() {
  let now = 1_000;
  let offline = false;
  const runtime = createRuntime({
    model: compile(graph),
    graphId: 'field-status',
    clock: () => now,
    sources: {
      records: {
        connectionId: 'test',
        authorization: 'shared-service',
        connector: {
          async fetch(id) {
            if (offline) throw new Error('offline');

            return {
              state: 'present',
              record: { id, name: 'Northwind', revenue: 10 },
            };
          },
        },
      },
    },
    actionHandlers: {
      [AddNote.id]: async (context) => ({
        noteId: (await context.create(Note.id, context.input)).id,
      }),
    },
  });

  return {
    runtime,
    advance: (ms: number) => {
      now += ms;
    },
    disconnect: () => {
      offline = true;
    },
  };
}

it('reports a role-denied field as forbidden without degrading the read', async () => {
  const { runtime } = fixture();
  const id = await runtime.adopt(Customer.id, '1');
  const hidden = await runtime.read(employee, Customer.id, id, {
    select: ['name', 'revenue'],
  });

  expect(hidden).toMatchObject({
    status: 'ok',
    data: { name: 'Northwind' },
    meta: {
      completeness: 'partial',
      degraded: false,
      fields: {
        name: { status: 'available', freshness: 'fresh' },
        revenue: { status: 'forbidden' },
      },
    },
  });
  expect(JSON.stringify(hidden)).not.toContain('10');
  await expect(
    runtime.read(employee, Customer.id, id, {
      select: ['name', 'revenue'],
      requireComplete: true,
    }),
  ).rejects.toThrow(new ReadError('incomplete'));
  expect(
    await runtime.read(finance, Customer.id, id, {
      select: ['name', 'revenue'],
    }),
  ).toMatchObject({
    data: { name: 'Northwind', revenue: 10 },
    meta: { completeness: 'complete', degraded: false },
  });
});

it('keeps unknown names unavailable even when a known field is forbidden', async () => {
  const { runtime } = fixture();
  const id = await runtime.adopt(Customer.id, '1');

  expect(
    await runtime.read(employee, Customer.id, id, {
      select: ['revenue', 'unknown'],
    }),
  ).toMatchObject({
    status: 'ok',
    data: {},
    meta: {
      completeness: 'partial',
      degraded: true,
      fields: {
        revenue: { status: 'forbidden' },
        unknown: { status: 'unavailable' },
      },
    },
  });
  expect(
    await runtime.read(finance, Customer.id, id, { select: ['unknown'] }),
  ).toMatchObject({
    meta: { degraded: true, fields: { unknown: { status: 'unavailable' } } },
  });
});

it('reports an omitted stale value as unavailable, not forbidden', async () => {
  const { runtime, advance, disconnect } = fixture();
  const id = await runtime.adopt(Customer.id, '1');

  advance(120_000);
  disconnect();
  expect(
    await runtime.read(finance, Customer.id, id, {
      select: ['name', 'revenue'],
      stale: 'omit',
    }),
  ).toMatchObject({
    status: 'ok',
    data: {},
    meta: {
      completeness: 'partial',
      degraded: true,
      fields: {
        name: { status: 'unavailable' },
        revenue: { status: 'unavailable' },
      },
    },
  });
  expect(
    await runtime.read(employee, Customer.id, id, {
      select: ['name', 'revenue'],
      stale: 'omit',
    }),
  ).toMatchObject({
    meta: {
      degraded: true,
      fields: {
        name: { status: 'unavailable' },
        revenue: { status: 'forbidden' },
      },
    },
  });
});

it('distinguishes forbidden from unavailable on native objects', async () => {
  const { runtime } = fixture();
  const receipt = await runtime.invoke(finance, AddNote.id, {
    input: { body: 'Quarterly', amount: 42 },
    idempotencyKey: 'note',
  });
  const noteId = (receipt.output as { noteId: string }).noteId;

  expect(
    await runtime.read(employee, Note.id, noteId, {
      select: ['body', 'amount', 'unknown'],
    }),
  ).toMatchObject({
    status: 'ok',
    data: { body: 'Quarterly' },
    meta: {
      completeness: 'partial',
      degraded: true,
      fields: {
        body: { status: 'available', source: 'native' },
        amount: { status: 'forbidden' },
        unknown: { status: 'unavailable' },
      },
    },
  });
  expect(
    await runtime.read(employee, Note.id, noteId, {
      select: ['body', 'amount'],
    }),
  ).toMatchObject({
    data: { body: 'Quarterly' },
    meta: { completeness: 'partial', degraded: false },
  });
  await expect(
    runtime.read(employee, Note.id, noteId, {
      select: ['amount'],
      requireComplete: true,
    }),
  ).rejects.toThrow(new ReadError('incomplete'));
  expect(
    await runtime.read(finance, Note.id, noteId, {
      select: ['body', 'amount'],
    }),
  ).toMatchObject({
    data: { body: 'Quarterly', amount: 42 },
    meta: { completeness: 'complete', degraded: false },
  });
  expect(await runtime.read(employee, Note.id, noteId)).toMatchObject({
    data: { body: 'Quarterly' },
    meta: { completeness: 'complete', degraded: false },
  });
});
