import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  defineSource,
  from,
  objectId,
  source,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';

it.each([
  [z.string(), 'north', 'south'],
  [z.number(), 42, 43],
  [z.boolean(), true, false],
] as const)(
  'enforces typed claims through an authorized read (%s)',
  async (schema, value, other) => {
    const access = defineAccess({
      roles: ['employee', 'finance'],
      fieldGroups: ['ordinary', 'financial'],
      claims: { scope: schema },
    });
    const records = defineSource({
      id: 'records',
      idField: 'id',
      schema: z.object({ id: z.string(), scope: schema, revenue: z.number() }),
    });
    const Customer = defineObject({
      id: 'customer',
      name: 'Customer',
      membership: source(records),
      properties: {
        id: objectId({
          id: 'customer.id',
          access: access.groups.ordinary,
        }),
        scope: from(records.fields.scope, {
          id: 'customer.scope',
          access: access.groups.ordinary,
        }),
        revenue: from(records.fields.revenue, {
          id: 'customer.revenue',
          access: access.groups.financial,
        }),
      },
    });
    const graph = defineGraph({
      id: 'graph',
      access,
      objects: { Customer },
      policies: {
        Customer: {
          read: {
            gate: access.role('employee'),
            where: { scope: { eq: access.claims.scope } },
            evidenceMaxAgeMs: 1000,
          },
          groups: { financial: access.role('finance') },
        },
      },
    });
    const options = {
      model: compile(graph),
      graphId: 'test',
      sources: {
        records: {
          connectionId: 'test',
          authorization: 'shared-service' as const,
          connector: {
            fetch: async () => ({
              state: 'present' as const,
              record: { id: '1', scope: value, revenue: 10 },
            }),
          },
        },
      },
    };
    const runtime = createRuntime(options);
    const id = await runtime.adopt('customer', '1');

    expect(
      await runtime.read(
        { id: 'ana', roles: ['employee'], claims: { scope: value } },
        'customer',
        id,
        { select: ['id', 'scope', 'revenue'] },
      ),
    ).toMatchObject({
      status: 'ok',
      data: { id, scope: value },
      meta: { fields: { revenue: { status: 'unavailable' } } },
    });
    expect(
      await runtime.read(
        { id: 'ana', roles: ['employee', 'finance'], claims: { scope: value } },
        'customer',
        id,
      ),
    ).toMatchObject({ status: 'ok', data: { revenue: 10 } });

    for (const principal of [
      { id: 'ana', roles: ['employee'], claims: {} },
      { id: 'ana', roles: ['employee'], claims: { scope: other } },
      { id: 'ana', roles: ['employee'], claims: { scope: null } },
      { id: 'ana', roles: ['employe'], claims: { scope: value } },
    ])
      expect(await runtime.read(principal, 'customer', id)).toEqual({
        status: 'not-found',
      });

    const denied = createRuntime({
      ...options,
      model: compile({ ...graph, policies: { Customer: { read: 'deny' } } }),
    });
    const deniedId = await denied.adopt('customer', '1');

    expect(
      await denied.read(
        { id: 'ana', roles: ['employee'], claims: { scope: value } },
        'customer',
        deniedId,
      ),
    ).toEqual({ status: 'not-found' });
  },
);
