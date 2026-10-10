import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  connect,
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  defineSource,
  from,
  implementAction,
  native,
  nativeMembership,
  objectId,
  source,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import type { ObservationStore } from 'relate/storage';

export function timestampQueryContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    const cleanup: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
    });

    async function setup() {
      const backing = await open();

      cleanup.push(backing.close);
      const timestamp = z.iso.datetime({ offset: true, precision: 3 });
      const access = defineAccess({
        roles: ['reader'],
        fieldGroups: ['ordinary'],
        claims: {},
      });
      const events = defineSource({
        id: 'events',
        idField: 'id',
        schema: z.object({
          id: z.string(),
          at: timestamp.optional().nullable(),
        }),
      });
      const Event = defineObject({
        id: 'event',
        membership: source(events),
        properties: {
          id: objectId({ id: 'event.id' }),
          at: from(events.fields.at, { id: 'event.at' }),
        },
      });
      const Entry = defineObject({
        id: 'entry',
        membership: nativeMembership(),
        properties: {
          id: objectId({ id: 'entry.id' }),
          at: native(timestamp, { id: 'entry.at' }),
        },
      });
      const Create = defineAction({
        id: 'create',
        input: z.object({ at: timestamp }),
        output: z.object({ count: z.number() }),
        creates: [Entry],
        policy: { execute: access.role('reader') },
      });
      const graph = defineGraph({
        id: 'timestamps',
        objects: { Event, Entry },
        actions: { create: Create },
        access,
        policies: {
          Event: { read: { gate: access.role('reader') } },
          Entry: {
            read: { gate: access.role('reader') },
            create: { gate: access.role('reader') },
          },
        },
      });
      const records = new Map<string, { id: string; at?: string | null }>();
      const app = createRuntime({
        graph,
        graphId: randomUUID(),
        store: backing.store,
        actionImplementations: [
          implementAction(graph, Create, async ({ objects, input }) => {
            await objects.Entry.create({ at: input.at });
            const page = await objects.Entry.query({
              where: {
                at: {
                  gte: '2026-10-01T00:00:00.000Z',
                  lt: '2026-10-02T00:00:00.000Z',
                },
              },
            });

            return { count: page.data.length };
          }),
        ],
        connections: [
          connect(events, {
            connectionId: 'events',
            connector: {
              identity: 'application',
              fetch: async (id) => {
                const record = records.get(id);

                return record
                  ? { state: 'present', record }
                  : { state: 'deleted' };
              },
            },
          }),
        ],
      });

      cleanup.push(() => app.close());
      const consumer = app.as({ id: 'reader', roles: ['reader'], claims: {} });

      return {
        app,
        consumer,
        records,
        Event,
        manifest: compile(graph).manifest,
      };
    }

    it('compares instants across offsets, handles range edges and preserves source values', async () => {
      const { app, consumer, records, Event } = await setup();

      for (const [id, at] of [
        ['before', '2026-10-01T00:30:00.000+01:00'],
        ['start', '2026-10-01T01:00:00.000+01:00'],
        ['inside', '2026-10-01T00:30:00.000Z'],
        ['end', '2026-10-02T00:00:00.000Z'],
        ['null', null],
        ['absent', undefined],
      ] as const) {
        records.set(id, { id, ...(at !== undefined ? { at } : {}) });
        await app.host.adopt(Event, id);
      }

      const rows = [];

      for await (const row of consumer.objects.Event.query({
        where: {
          at: {
            gte: '2026-10-01T00:00:00.000Z',
            lt: '2026-10-02T00:00:00.000Z',
          },
        },
        limit: 1,
      }))
        rows.push(row.data.at);

      expect(rows.sort()).toEqual([
        '2026-10-01T00:30:00.000Z',
        '2026-10-01T01:00:00.000+01:00',
      ]);

      for (const at of [
        '2026-10-01T00:00:00.000Z',
        { eq: '2026-10-01T00:00:00.000Z' },
        { in: ['2026-10-01T00:00:00.000Z'] },
        { gt: '2026-09-30T23:59:59.999Z', lte: '2026-10-01T00:00:00.000Z' },
      ]) {
        const result = await consumer.objects.Event.query({
          where: { at },
          select: [],
        });

        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.data).toEqual({});
      }

      expect(
        (await consumer.objects.Event.query({ where: { at: { eq: null } } }))
          .data,
      ).toHaveLength(1);
      expect(
        (await consumer.objects.Event.query({ where: { at: { in: [] } } }))
          .data,
      ).toEqual([]);
    });

    it('continues timestamp cursors across equivalent offsets', async () => {
      const { app, consumer, records, Event } = await setup();

      for (const id of ['a', 'b']) {
        records.set(id, { id, at: '2026-10-01T00:00:00.000Z' });
        await app.host.adopt(Event, id);
      }

      const first = await consumer.objects.Event.query({
        where: { at: { gte: '2026-10-01T00:00:00.000Z' } },
        limit: 1,
      });

      expect(first.meta.exhausted).toBe(false);

      if (first.meta.exhausted) return;

      const next = await consumer.objects.Event.query({
        where: { at: { gte: '2026-10-01T01:00:00.000+01:00' } },
        limit: 1,
        cursor: first.meta.continuationCursor,
      });

      expect(next.data).toHaveLength(1);
      expect(next.data[0]!.id).not.toBe(first.data[0]!.id);
    });

    it('validates timestamp operands on empty graphs and describes the actual operators', async () => {
      const { consumer, manifest } = await setup();

      for (const at of [
        { gt: '2026-10-01' },
        { gte: '2026-02-29T00:00:00.000Z' },
        { eq: '2026-10-01T00:00:00.000' },
        { lt: '2026-10-01T00:00:00Z' },
        { in: ['2026-10-01T00:00:00.0001Z'] },
        { gt: null },
      ])
        await expect(
          consumer.objects.Event.query({ where: { at } } as never),
        ).rejects.toMatchObject({ code: 'invalid-request' });

      expect(
        consumer.objects.Event.describe()!.properties.find(
          (p) => p.name === 'at',
        ),
      ).toMatchObject({
        schema: {
          type: 'string',
          format: 'timestamp',
          nullable: true,
          optional: true,
        },
        filterOperators: ['eq', 'in', 'gt', 'gte', 'lt', 'lte'],
      });
      expect(manifest.actions![0]!.input.at).toMatchObject({
        format: 'timestamp',
      });
    });

    it('rejects invalid source timestamps and supports native read-your-writes and action validation', async () => {
      const { app, consumer, records, Event } = await setup();

      records.set('bad', { id: 'bad', at: '2026-10-01' });
      await expect(app.host.adopt(Event, 'bad')).rejects.toThrow();
      await expect(
        consumer.actions.create({
          input: { at: '2026-10-01' },
          idempotencyKey: 'bad',
        }),
      ).rejects.toThrow();
      expect(
        await consumer.actions.create({
          input: { at: '2026-10-01T01:00:00.000+01:00' },
          idempotencyKey: 'good',
        }),
      ).toMatchObject({ output: { count: 1 } });
      expect(
        (
          await consumer.objects.Entry.query({
            where: { at: '2026-10-01T00:00:00.000Z' },
          })
        ).data,
      ).toHaveLength(1);
    });
  });
}
