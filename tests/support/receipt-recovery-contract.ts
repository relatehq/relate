import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  assertFields,
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
  referenceInput,
} from 'relate';
import { createRuntime } from '@relate/node';
import type { ObservationStore } from '@relate/runtime/storage';
import {
  NativeCommitUncertain,
  StorageUnavailable,
} from '@relate/runtime/storage';

const access = defineAccess({
  roles: ['employee', 'finance'],
  fieldGroups: ['ordinary', 'financial'],
  claims: {},
});
const Secret = defineObject({
  id: 'secret',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'secret.id' }),
    value: native(z.string(), {
      id: 'secret.value',
      access: access.groups.financial,
    }),
    optionalValue: native(z.string().optional(), {
      id: 'secret.optional-value',
      access: access.groups.financial,
    }),
  },
});
const Create = defineAction({
  id: 'create',
  input: z.object({ value: z.string() }),
  output: z.object({ id: referenceInput(Secret) }),
  creates: [Secret],
  policy: { execute: access.role('employee') },
});
const Reveal = defineAction({
  id: 'reveal',
  input: z.object({ id: referenceInput(Secret) }),
  output: z.object({ value: z.string() }),
  creates: [],
  policy: { execute: access.role('employee') },
});
const Reject = defineAction({
  ...Reveal,
  id: 'reject',
  errors: { privateReason: z.object({ value: z.string() }) },
});
const Other = defineAction({ ...Reveal, id: 'other' });
const graph = defineGraph({
  id: 'receipt-graph',
  objects: { Secret },
  actions: { create: Create, reveal: Reveal, other: Other, reject: Reject },
  access,
  policies: {
    Secret: {
      read: { gate: access.role('employee') },
      create: { gate: access.role('employee') },
      groups: { financial: access.role('finance') },
    },
  },
});
const actor = { id: 'ana', roles: ['employee', 'finance'], claims: {} };

export function receiptRecoveryContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let graphId: string;
    let executions: number;

    beforeEach(async () => {
      backing = await open();
      graphId = randomUUID();
      executions = 0;
    });
    afterEach(async () => {
      await backing?.close();
    });

    function app(store = backing.store, actionTimeoutMs = 60_000) {
      return createRuntime({
        graph,
        graphId,
        store,
        actionTimeoutMs,
        connections: [],
        actionImplementations: [
          implementAction(graph, Create, async ({ objects, input }) =>
            objects.Secret.create({ ...input, optionalValue: undefined }),
          ),
          implementAction(graph, Reveal, async ({ objects, input }) => {
            executions++;
            const record = await objects.Secret.get(input.id, {
              select: ['value'],
            });

            assertFields(record, ['value']);

            return { value: record.data.value };
          }),
          implementAction(graph, Reject, async ({ objects, input, fail }) => {
            executions++;
            const record = await objects.Secret.get(input.id, {
              select: ['value'],
            });

            assertFields(record, ['value']);

            return fail('privateReason', { value: record.data.value });
          }),
          implementAction(graph, Other, async ({ objects, input }) => {
            executions++;
            const record = await objects.Secret.get(input.id, {
              select: ['optionalValue'],
            });

            if (record.status !== 'ok') throw new Error('Missing secret');

            return { value: record.data.optionalValue ?? 'absent' };
          }),
        ],
      });
    }

    it('rechecks field access before disclosing scalar domain-failure details', async () => {
      const relate = app();
      const created = await relate.as(actor).actions.create({
        input: { value: 'Private failure reason' },
        idempotencyKey: 'create',
      });
      const request = {
        input: { id: created.output.id },
        idempotencyKey: 'reject',
      };
      const receipt = await relate.as(actor).actions.reject(request);

      expect(receipt).toMatchObject({
        state: 'failed',
        error: {
          code: 'privateReason',
          details: { value: 'Private failure reason' },
        },
      });
      const reduced = relate.as({ ...actor, roles: ['employee'] });

      expect(
        await reduced.objects.Secret.get(created.output.id, { select: ['id'] }),
      ).toMatchObject({ status: 'ok' });
      await expect(reduced.actions.reject(request)).rejects.toMatchObject({
        code: 'denied',
      });
      await expect(
        reduced.receipts.get(Reject, receipt.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as(actor).receipts.get(Reject, receipt.invocationId),
      ).resolves.toEqual(receipt);
      expect(executions).toBe(1);
    });

    it('rechecks field access before disclosing saved scalar output, without rerunning the handler', async () => {
      const relate = app();
      const created = await relate.as(actor).actions.create({
        input: { value: 'Private amount' },
        idempotencyKey: 'create',
      });
      const request = {
        input: { id: created.output.id },
        idempotencyKey: 'reveal',
      };
      const saved = await relate.as(actor).actions.reveal(request);
      const restricted = relate.as({ ...actor, roles: ['employee'] });

      // Object visibility and the action gate still pass; only the read field was revoked.
      expect(
        (await restricted.objects.Secret.get(created.output.id, { select: [] }))
          .status,
      ).toBe('ok');
      await expect(
        restricted.receipts.get(Reveal, saved.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(restricted.actions.reveal(request)).rejects.toMatchObject({
        code: 'denied',
      });
      await expect(
        relate.as(actor).receipts.get(Reveal, saved.invocationId),
      ).resolves.toEqual(saved);
      await expect(relate.as(actor).actions.reveal(request)).resolves.toEqual(
        saved,
      );
      expect(executions).toBe(1);
      // Returned receipt objects never expose mutable store state.
      saved.output.value = 'caller mutation';
      expect(
        (await relate.as(actor).receipts.get(Reveal, saved.invocationId)).output
          .value,
      ).toBe('Private amount');
    });

    it('keeps wrong-action, wrong-graph, hidden and missing lookups indistinguishable', async () => {
      const relate = app();
      const saved = await relate.as(actor).actions.create({
        input: { value: 'Private' },
        idempotencyKey: 'create',
      });
      const errors = await Promise.all(
        [
          relate.as(actor).receipts.get(Other, saved.invocationId),
          relate.as(actor).receipts.get(Create, 'unknown'),
          relate
            .as({ ...actor, id: 'ben' })
            .receipts.get(Create, saved.invocationId),
        ].map((operation) => operation.catch((error: unknown) => error)),
      );

      expect(errors[0]).toMatchObject({ code: 'denied' });
      expect(errors.map((error) => JSON.stringify(error))).toEqual(
        Array(3).fill(JSON.stringify(errors[0])),
      );
      graphId = randomUUID();
      await expect(
        app().as(actor).receipts.get(Create, saved.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
    });

    it('protects output derived from a known absent restricted field', async () => {
      const relate = app();
      const created = await relate.as(actor).actions.create({
        input: { value: 'Private' },
        idempotencyKey: 'create',
      });
      const request = {
        input: { id: created.output.id },
        idempotencyKey: 'optional',
      };
      const saved = await relate.as(actor).actions.other(request);

      expect(saved.output.value).toBe('absent');
      await expect(
        relate
          .as({ ...actor, roles: ['employee'] })
          .receipts.get(Other, saved.invocationId),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as({ ...actor, roles: ['employee'] }).actions.other(request),
      ).rejects.toMatchObject({ code: 'denied' });
      await expect(
        relate.as(actor).receipts.get(Other, saved.invocationId),
      ).resolves.toEqual(saved);
      expect(executions).toBe(1);
    });

    it('sanitizes receipt storage failures and bounds a stalled lookup', async () => {
      const relate = app();
      const saved = await relate.as(actor).actions.create({
        input: { value: 'Private' },
        idempotencyKey: 'create',
      });
      const native = backing.store.native!;

      for (const [error, code] of [
        [new Error('database credential'), 'internal'],
        [new StorageUnavailable(), 'unavailable'],
      ] as const) {
        const failing: ObservationStore = {
          ...backing.store,
          native: {
            ...native,
            transaction: (scope, operation) =>
              native.transaction(scope, (transaction) =>
                operation({
                  ...transaction,
                  async findInvocation() {
                    throw error;
                  },
                }),
              ),
          },
        };

        await expect(
          app(failing).as(actor).receipts.get(Create, saved.invocationId),
        ).rejects.toMatchObject({ code });
      }

      const stalled: ObservationStore = {
        ...backing.store,
        native: {
          ...native,
          transaction: (scope, operation) =>
            native.transaction(scope, (transaction) =>
              operation({
                ...transaction,
                findInvocation: () => new Promise(() => {}),
              }),
            ),
        },
      };

      await expect(
        app(stalled, 20).as(actor).receipts.get(Create, saved.invocationId),
      ).rejects.toMatchObject({ code: 'unavailable' });
      await expect(
        relate.as(actor).receipts.get(Create, saved.invocationId),
      ).resolves.toEqual(saved);
      const uncertain: ObservationStore = {
        ...backing.store,
        native: {
          ...native,
          async transaction(scope, operation) {
            await native.transaction(scope, operation);
            throw new NativeCommitUncertain();
          },
        },
      };

      await expect(
        app(uncertain).as(actor).receipts.get(Create, saved.invocationId),
      ).rejects.toMatchObject({ code: 'unavailable' });
      const caller = relate.as(actor);

      await relate.close();
      await expect(
        caller.receipts.get(Create, saved.invocationId),
      ).rejects.toThrow('Relate is closed');
    });
  });
}
