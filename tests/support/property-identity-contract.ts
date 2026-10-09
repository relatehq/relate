import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { canonicalJson, validateManifest } from 'relate/model';
import { createRuntime } from '@relate/runtime';
import type { ObservationStore, StorageScope } from '@relate/runtime/storage';
import { createCustomerGraph } from './customer-graph.js';

export function propertyIdentityContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    function createFixture() {
      const { Customer, customerGraph, employee } = createCustomerGraph();
      const record = {
        id: 'crm_1',
        display_name: 'Northwind',
        portfolio: 'portfolio_north',
        revenue: 12,
      };
      const sources = {
        'crm.customers': {
          connectionId: 'crm',
          providerAccountId: 'crm-account',
          authorization: 'shared-service' as const,
          connector: {
            async identify() {
              return 'crm-account';
            },
            async fetch() {
              return {
                state: 'present' as const,
                record,
                providerAccountId: 'crm-account',
              };
            },
          },
        },
      };

      return { Customer, customerGraph, employee, record, sources };
    }

    it('keeps stored property identity across API renames while projecting current names', async () => {
      const { Customer, customerGraph, employee, record, sources } =
        createFixture();

      const backing = await open();
      const { name: property, ...rest } = Customer.properties;
      const renamed = {
        ...customerGraph,
        objects: {
          Customer: {
            ...Customer,
            properties: { ...rest, displayName: property },
          },
        },
      };
      const expected = {
        [Customer.properties.name.id]: 'Northwind',
        [Customer.properties.portfolio.id]: 'portfolio_north',
        [Customer.properties.revenue.id]: 12,
      };

      try {
        // Separate installations: this verifies stable payload keys, not an
        // automatic model migration (revision pinning still applies).
        for (const [graph, field] of [
          [customerGraph, 'name'],
          [renamed, 'displayName'],
        ] as const) {
          const model = compile(graph);
          const graphId = randomUUID();
          const runtime = createRuntime({
            model,
            graphId,
            sources,
            store: backing.store,
          });
          const id = await runtime.adopt(Customer.id, record.id);
          const scope: StorageScope = {
            graphId,
            definitionRevision: model.definitionRevision,
            objectDefinitionId: Customer.id,
            sourceDefinitionId: 'crm.customers',
            connectionId: 'crm',
            providerAccountId: 'crm-account',
            partition: 'shared-service',
          };
          const stored = (await backing.store.load(scope, id))!;

          expect(stored.observation.values).toEqual(expected);
          expect(stored.observation.raw).toEqual(record);
          expect(
            (await backing.store.resolve(scope, record.id))?.observation.values,
          ).toEqual(expected);
          expect(
            (await backing.store.scan(scope, { limit: 1 })).objects[0]
              ?.observation.values,
          ).toEqual(expected);
          const result = await runtime.read(employee, Customer.id, id, {
            select: [field, 'revenue'],
            evidence: 'full',
          });

          expect(result).toMatchObject({
            status: 'ok',
            data: { [field]: 'Northwind' },
            meta: {
              fields: {
                [field]: { status: 'available' },
                revenue: { status: 'forbidden' },
              },
            },
          });

          if (result.status !== 'ok') throw new Error('Expected customer');

          expect(Object.keys(result.data)).toEqual([field]);
          expect(
            await runtime.read(
              { ...employee, claims: { portfolio: 'other' } },
              Customer.id,
              id,
            ),
          ).toEqual({ status: 'not-found' });
        }
      } finally {
        await backing.close();
      }
    });

    it.each([false, true])(
      'rejects name-keyed values under the current revision (where policy: %s)',
      async (where) => {
        const { Customer, customerGraph, employee, record, sources } =
          createFixture();

        const backing = await open();
        const model = compile(
          where
            ? customerGraph
            : {
                ...customerGraph,
                policies: {
                  Customer: {
                    ...customerGraph.policies.Customer,
                    read: { gate: customerGraph.policies.Customer.read.gate },
                  },
                },
              },
        );
        const graphId = randomUUID();
        const scope: StorageScope = {
          graphId,
          definitionRevision: model.definitionRevision,
          objectDefinitionId: Customer.id,
          sourceDefinitionId: 'crm.customers',
          connectionId: 'crm',
          providerAccountId: 'crm-account',
          partition: 'shared-service',
        };

        try {
          // Model the persisted state after a revision-only migration: install
          // succeeds, but the existing payload still uses the old property names.
          await backing.store.install(graphId, model.definitionRevision);
          const saved = await backing.store.accept(scope, {
            sourceRecordId: record.id,
            adopt: true,
            observation: {
              state: 'present',
              raw: record,
              values: {
                name: 'Northwind',
                portfolio: 'portfolio_north',
                revenue: 12,
              },
              observedAt: Date.now(),
              token: await backing.store.beginFetch(),
            },
          });
          const runtime = createRuntime({
            model,
            graphId,
            sources,
            store: backing.store,
          });

          for (const refresh of [false, true]) {
            await expect(
              runtime.read(employee, Customer.id, saved.object.objectId, {
                refresh,
              }),
            ).rejects.toThrow(
              'Stored observation values must use property IDs; explicit migration required',
            );
          }

          expect(
            await backing.store.load(scope, saved.object.objectId),
          ).toEqual(saved.object);
        } finally {
          await backing.close();
        }
      },
    );

    it('refuses a legacy manifest revision without rewriting data', async () => {
      const { Customer, customerGraph, employee, record, sources } =
        createFixture();

      const backing = await open();
      const model = compile(customerGraph);
      const legacy = { ...model.manifest, formatVersion: 4 };
      const revision = `sha256:${createHash('sha256').update(canonicalJson(legacy)).digest('hex')}`;
      const graphId = randomUUID();
      const scope: StorageScope = {
        graphId,
        definitionRevision: revision,
        objectDefinitionId: Customer.id,
        sourceDefinitionId: 'crm.customers',
        connectionId: 'crm',
        providerAccountId: 'crm-account',
        partition: 'shared-service',
      };

      try {
        expect(model.manifest.formatVersion).toBe(5);
        expect(() => validateManifest(legacy)).toThrow();
        await backing.store.install(graphId, revision);
        const saved = await backing.store.accept(scope, {
          sourceRecordId: record.id,
          adopt: true,
          observation: {
            state: 'present',
            raw: record,
            values: {
              name: 'Northwind',
              portfolio: 'portfolio_north',
              revenue: 12,
            },
            observedAt: Date.now(),
            token: await backing.store.beginFetch(),
          },
        });
        const runtime = createRuntime({
          model,
          graphId,
          sources,
          store: backing.store,
        });

        await expect(
          runtime.read(employee, Customer.id, saved.object.objectId),
        ).rejects.toThrow('explicit migration required');
        await expect(runtime.adopt(Customer.id, record.id)).rejects.toThrow(
          'explicit migration required',
        );
        expect(await backing.store.load(scope, saved.object.objectId)).toEqual(
          saved.object,
        );
      } finally {
        await backing.close();
      }
    });
  });
}
