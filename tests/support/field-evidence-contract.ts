import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
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
import type { ObservationStore } from '@relate/runtime/storage';

const access = defineAccess({
  roles: ['employee', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: {},
});
const records = defineSource({
  id: 'records',
  idField: 'id',
  schema: z.object({ id: z.string(), revenue: z.number() }),
});
const SourceCustomer = defineObject({
  id: 'source-customer',
  membership: source(records),
  properties: {
    id: objectId({ id: 'source.id' }),
    revenue: from(records.fields.revenue, {
      id: 'source.revenue',
      access: access.groups.financial,
    }),
  },
});
const NativeCustomer = defineObject({
  id: 'native-customer',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'native.id' }),
    revenue: native(z.number(), {
      id: 'native.revenue',
      access: access.groups.financial,
    }),
  },
});
const policy = {
  read: { gate: access.role('employee') },
  groups: { financial: access.role('finance') },
};
const model = compile(
  defineGraph({
    id: 'field-evidence',
    access,
    objects: { SourceCustomer, NativeCustomer },
    policies: { SourceCustomer: policy, NativeCustomer: policy },
  }),
);
const ana = { id: 'ana', roles: ['employee'], claims: {} };
const fin = { id: 'fin', roles: ['employee', 'finance'], claims: {} };

export function fieldEvidenceContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let runtime: ReturnType<typeof createRuntime>;
    let sourceId: string;
    const nativeId = 'native-1';

    beforeEach(async () => {
      backing = await open();
      const graphId = randomUUID();

      runtime = createRuntime({
        model,
        graphId,
        store: backing.store,
        clock: () => 1_000,
        sources: {
          records: {
            providerAccountId: 'example-account',
            connectionId: 'test',
            authorization: 'shared-service',
            connector: {
              identify: async () => 'example-account',
              fetch: async () => ({
                providerAccountId: 'example-account',
                state: 'present',
                record: { id: 'source-1', revenue: 250_000 },
              }),
            },
          },
        },
      });
      sourceId = await runtime.adopt(SourceCustomer.id, 'source-1');
      // Seed native storage through its public adapter contract.
      await backing.store.native!.transaction(
        { graphId, definitionRevision: model.definitionRevision },
        (transaction) =>
          transaction.insert({
            objectDefinitionId: NativeCustomer.id,
            objectId: nativeId,
            values: { 'native.revenue': 250_000 },
            createdAt: 1_000,
          }),
      );
    });
    afterEach(async () => {
      await backing?.close();
    });

    for (const object of [SourceCustomer, NativeCustomer]) {
      const id = () => (object === SourceCustomer ? sourceId : nativeId);

      it(`${object.id}: distinguishes forbidden from unknown without exposing private evidence`, async () => {
        const denied = await runtime.read(ana, object.id, id(), {
          select: ['revenue'],
        });

        expect(denied).toEqual({
          status: 'ok',
          id: id(),
          data: {},
          meta: {
            completeness: 'partial',
            degraded: false,
            definitionRevision: model.definitionRevision,
            fields: { revenue: { status: 'forbidden' } },
            evidence: 'compact',
          },
        });
        expect(
          await runtime.read(ana, object.id, id(), {
            select: ['revenue', 'unknown'],
          }),
        ).toMatchObject({
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
        const permitted = await runtime.read(fin, object.id, id(), {
          select: ['revenue', 'unknown'],
        });

        expect(permitted).toMatchObject({
          data: { revenue: 250_000 },
          meta: {
            degraded: true,
            fields: {
              unknown: { status: 'unavailable' },
            },
          },
        });
      });

      it(`${object.id}: keeps default selection complete and whole-object denial opaque`, async () => {
        const result = await runtime.read(ana, object.id, id(), {
          requireComplete: true,
        });

        expect(result).toMatchObject({
          status: 'ok',
          data: { id: id() },
          meta: { completeness: 'complete', degraded: false },
        });

        if (result.status !== 'ok') throw new Error('Expected customer');

        expect(result.meta.fields).toBeUndefined();
        expect(
          await runtime.read({ ...ana, roles: [] }, object.id, id(), {
            select: ['revenue', 'unknown'],
            requireComplete: true,
          }),
        ).toEqual({ status: 'not-found' });
      });

      it.each(['revenue', 'unknown'])(
        `${object.id}: rejects incomplete explicit selection of %s`,
        async (field) => {
          await expect(
            runtime.read(ana, object.id, id(), {
              select: [field],
              requireComplete: true,
            }),
          ).rejects.toMatchObject({
            code: 'incomplete',
            message: 'incomplete',
          });
        },
      );
    }
  });
}
