import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defineAction,
  defineGraph,
  implementAction,
  bind,
  referenceInput,
} from 'relate';
import { createRuntime } from '@relate/node';
import type { ObservationStore } from '@relate/runtime/storage';
import {
  access,
  Customer,
  customers,
  ana,
  AccountReview,
  graph as baseGraph,
} from './native-action-model.js';

export function adoptionActionContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(`${name} adoption`, () => {
    for (const outcome of [
      'success',
      'throw',
      'fail',
      'invalid',
      'caught',
      'race',
      'same',
      'different',
      'refresh',
      'denied',
      'deleted',
      'failure-reference',
      'recovery',
    ] as const) {
      it(`adopt, read, query and ${outcome}`, async () => {
        const backing = await open();

        try {
          const Adopt = defineAction({
            id: 'adopt',
            input: z.object({}),
            output: z.object({ id: referenceInput(Customer) }),
            adopts: [Customer],
            creates: [AccountReview],
            errors: {
              cancelled: z.object({}),
              discarded: z.object({ customer: referenceInput(Customer) }),
            },
            policy: { execute: access.role('employee') },
          });
          const graph = defineGraph({
            id: 'adoption',
            objects: { Customer, AccountReview },
            actions: { adopt: Adopt },
            access,
            policies: {
              AccountReview: baseGraph.policies.AccountReview,
              Customer: {
                read: {
                  gate: access.role('employee'),
                  where: { portfolio: { eq: access.claims.portfolio } },
                  evidenceMaxAgeMs: 30_000,
                },
              },
            },
          });
          let pendingId = '';
          let calls = 0;
          let sourceName = 'New customer';
          let now = 10_000;
          let reachedEnd = false;
          // Test-owned provider state survives a lost create response. Recovery
          // looks up the operation key before attempting another external create.
          const external = new Map<string, string>();
          const journal = new Map<string, string>();
          let externalCreates = 0;
          const app = createRuntime({
            graph,
            graphId: randomUUID(),
            store: backing.store,
            clock: () => now,
            bindings: [
              bind(customers, {
                providerAccountId: 'account',
                connectionId: 'crm',
                resourceId: 'customers',
                connector: {
                  identify: async () => 'account',
                  fetch: async (id) => ({
                    providerAccountId: 'account',
                    state: outcome === 'deleted' ? 'deleted' : 'present',
                    record: {
                      id,
                      name: sourceName,
                      portfolio: outcome === 'denied' ? 'south' : 'north',
                    },
                  }),
                },
              }),
            ],
            actionImplementations: [
              implementAction(
                graph,
                Adopt,
                async ({ objects, fail, actor, idempotencyId }) => {
                  calls++;

                  if (outcome === 'recovery') {
                    if (!journal.has(idempotencyId)) {
                      const recovered = external.get(idempotencyId);

                      if (recovered) journal.set(idempotencyId, recovered);
                      else {
                        externalCreates++;
                        external.set(idempotencyId, 'new');
                        throw new Error(
                          'Provider created the record but its response was lost',
                        );
                      }
                    }

                    expect(journal.get(idempotencyId)).toBe('new');
                  }

                  const [first, second] = await Promise.all([
                    objects.Customer.adopt('new'),
                    objects.Customer.adopt('new'),
                  ]);

                  expect(first.id).toBe(second.id);
                  pendingId = first.id;
                  expect((await objects.Customer.get(first.id)).status).toBe(
                    'ok',
                  );
                  const query = await objects.Customer.query();

                  expect(query.data.map((x) => x.id)).toContain(first.id);

                  if (!['same', 'different'].includes(outcome))
                    expect(
                      (await app.as(ana).objects.Customer.get(first.id)).status,
                    ).toBe('not-found');

                  await objects.AccountReview.create({
                    customer: first.id,
                    author: actor.id,
                    note: 'Adopted customer',
                  });
                  const full = await objects.Customer.get(first.id, {
                    evidence: 'full',
                  });

                  if (full.status === 'ok')
                    expect(full.meta.fields.name).toMatchObject({
                      retention: 'unconfirmed',
                      ordering: 'unconfirmed',
                    });

                  if (outcome === 'refresh') {
                    now += 60_001;
                    sourceName = 'Refreshed customer';
                    const refreshed = await objects.Customer.get(first.id, {
                      maxAgeMs: 1,
                    });

                    expect(
                      refreshed.status === 'ok' && refreshed.data.name,
                    ).toBe('Refreshed customer');
                  }

                  if (['race', 'same', 'different'].includes(outcome)) {
                    if (outcome === 'different') sourceName = 'Changed by host';

                    await app.host.adopt(Customer, 'new');
                  }

                  reachedEnd = true;

                  if (outcome === 'failure-reference')
                    return fail('discarded', { customer: first.id });

                  if (outcome === 'throw') throw new Error('abort');

                  if (outcome === 'fail') return fail('cancelled', {});

                  if (outcome === 'caught') {
                    try {
                      await objects.Customer.adopt('');
                    } catch {}
                  }

                  return {
                    id:
                      outcome === 'invalid'
                        ? ('' as typeof first.id)
                        : first.id,
                  };
                },
              ),
            ],
          });

          if (['same', 'different'].includes(outcome))
            await app.host.adopt(Customer, 'new');

          const request = { input: {}, idempotencyKey: 'key' };

          if (outcome === 'recovery')
            await expect(app.as(ana).actions.adopt(request)).rejects.toThrow();

          if (
            ['success', 'fail', 'same', 'refresh', 'recovery'].includes(outcome)
          ) {
            const receipt = await app.as(ana).actions.adopt(request);

            expect(receipt.state).toBe(
              outcome === 'fail' ? 'failed' : 'succeeded',
            );
            expect(await app.as(ana).actions.adopt(request)).toEqual(receipt);
            expect(calls).toBe(outcome === 'recovery' ? 2 : 1);

            if (outcome === 'recovery') expect(externalCreates).toBe(1);

            if (outcome === 'success' || outcome === 'refresh') {
              expect(
                await app.host.provenance({
                  objectDefinitionId: Customer.id,
                  objectId: pendingId,
                }),
              ).toMatchObject({
                kind: 'adopted',
                invocationId: receipt.invocationId,
              });
              const feed = await app.host.activity.feed.read({ limit: 100 });

              expect(feed.entries.map((e) => e.kind)).toEqual([
                'adopted',
                'created',
                'invocation-succeeded',
              ]);
            }
          } else
            await expect(app.as(ana).actions.adopt(request)).rejects.toThrow();

          if (!['denied', 'deleted'].includes(outcome))
            expect(reachedEnd).toBe(true);

          if (pendingId)
            expect(
              (await app.as(ana).objects.Customer.get(pendingId as never))
                .status,
            ).toBe(
              ['success', 'same', 'different', 'refresh', 'recovery'].includes(
                outcome,
              )
                ? 'ok'
                : 'not-found',
            );
        } finally {
          await backing.close();
        }
      });
    }
  });
}
