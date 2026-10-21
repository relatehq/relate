import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bind,
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  localDateTime,
  objectId,
  reference,
  source,
} from 'relate';
import { createRuntime } from '@relate/node';
import type { ObservationStore } from 'relate/storage';

export function localDateTimeContract(
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
      const access = defineAccess({
        roles: ['reader'],
        fieldGroups: ['ordinary'],
        claims: {},
      });
      const calendars = defineSource({
        id: 'scheduling.calendars',
        idField: 'id',
        schema: z.object({ id: z.string() }),
      });
      const Calendar = defineObject({
        id: 'calendar',
        membership: source(calendars),
        properties: { id: objectId({ id: 'calendar.id' }) },
      });
      const appointments = defineSource({
        id: 'scheduling.appointments',
        idField: 'id',
        schema: z.object({
          id: z.string(),
          calendar: z.string(),
          startsAt: localDateTime({ precision: 'second' })
            .nullable()
            .optional(),
        }),
      });
      const Appointment = defineObject({
        id: 'appointment',
        membership: source(appointments),
        properties: {
          id: objectId({ id: 'appointment.id' }),
          calendar: reference(Calendar, {
            id: 'appointment.calendar',
            from: appointments.fields.calendar,
          }),
          startsAt: from(appointments.fields.startsAt, {
            id: 'appointment.startsAt',
          }),
        },
      });
      const graph = defineGraph({
        id: 'scheduling',
        access,
        objects: { Calendar, Appointment },
        relationships: {
          CalendarAppointments: defineRelationship({
            id: 'calendar.appointments',
            forward: 'appointments',
            reverse: 'calendar',
            via: Appointment.properties.calendar,
          }),
        },
        policies: {
          Calendar: { read: { gate: access.role('reader') } },
          Appointment: { read: { gate: access.role('reader') } },
        },
      });
      const rows = new Map<
        string,
        { id: string; calendar: string; startsAt?: string | null }
      >();
      const app = createRuntime({
        graph,
        graphId: randomUUID(),
        store: backing.store,
        bindings: [
          bind(calendars, {
            connectionId: 'calendars',
            resourceId: 'records',
            connector: {
              identity: 'application',
              fetch: async (id) => ({ state: 'present', record: { id } }),
            },
          }),
          bind(appointments, {
            connectionId: 'schedule',
            resourceId: 'records',
            connector: {
              identity: 'application',
              fetch: async (id) => {
                const record = rows.get(id);

                return record
                  ? { state: 'present', record }
                  : { state: 'deleted' };
              },
            },
          }),
        ],
      });

      cleanup.push(() => app.close());

      const calendarId = await app.host.adopt(Calendar, 'primary');

      await app.host.adopt(Calendar, 'secondary');

      for (const [id, startsAt] of [
        ['before', '2024-02-28T23:59:59'],
        ['leap', '2024-02-29T00:00:00'],
        ['end', '2024-03-01T00:00:00'],
        ['null', null],
        ['absent', undefined],
      ] as const) {
        rows.set(id, {
          id,
          calendar: id === 'before' ? 'secondary' : 'primary',
          ...(startsAt === undefined ? {} : { startsAt }),
        });
        await app.host.adopt(Appointment, id);
      }

      const objects = app.as({
        id: 'scheduler',
        roles: ['reader'],
        claims: {},
      }).objects;

      return {
        appointments: objects.Appointment,
        calendars: objects.Calendar,
        calendarId,
      };
    }

    it('ranges over calendar boundaries with exact bounds, nullable and absent values', async () => {
      const { appointments } = await setup();
      const page = await appointments.query({
        where: {
          startsAt: { gte: '2024-02-29T00:00:00', lt: '2024-03-01T00:00:00' },
        },
      });

      expect(page.data.map((r) => r.data.startsAt)).toEqual([
        '2024-02-29T00:00:00',
      ]);
      expect(
        (await appointments.query({ where: { startsAt: null } })).data,
      ).toHaveLength(1);
      expect(
        (
          await appointments.query({
            where: {
              startsAt: {
                gt: '2024-03-01T00:00:00',
                lt: '2024-02-01T00:00:00',
              },
            },
          })
        ).data,
      ).toEqual([]);
    });
    it('combines local datetime ranges with related-record membership', async () => {
      const { calendars, calendarId } = await setup();
      const page = await calendars.traverse.appointments(calendarId, {
        where: {
          startsAt: { gte: '2024-02-01T00:00:00', lt: '2024-03-01T00:00:00' },
        },
        select: ['startsAt'],
        limit: 1,
      });

      expect(page.data.map((r) => r.data.startsAt)).toEqual([
        '2024-02-29T00:00:00',
      ]);
      await expect(
        calendars.traverse.appointments(calendarId, {
          where: { startsAt: { gte: '2024-02-01T00:00:00Z' } },
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    });
    it.each([
      '2023-02-29T00:00:00',
      '2024-02-29T00:00:00Z',
      '2024-02-29T00:00:00+01:00',
      '2024-02-29T00:00:00.000',
      '2024-04-31T00:00:00',
    ])('rejects invalid local range %s', async (gte) => {
      const { appointments } = await setup();

      await expect(
        appointments.query({ where: { startsAt: { gte } } }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    });
    it('binds cursor fingerprints to the local range', async () => {
      const { appointments } = await setup();
      const page = await appointments.query({
        limit: 1,
        where: { startsAt: { gte: '2024-01-01T00:00:00' } },
      });

      expect(page.meta.exhausted).toBe(false);

      if (page.meta.exhausted) throw new Error('Expected continuation');

      await expect(
        appointments.query({
          limit: 1,
          cursor: page.meta.continuationCursor,
          where: { startsAt: { gte: '2024-02-01T00:00:00' } },
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    });
  });
}
