import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
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
import type { ObservationStore } from 'relate/storage';

export function integerPropertyContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  it(`${name}: persists exact integers through action receipts, reads, policy and filtered cursors`, async () => {
    const backing = await open();
    const access = defineAccess({
      roles: ['editor'],
      fieldGroups: ['ordinary'],
      claims: { account: z.int64() },
    });
    const Balance = defineObject({
      id: 'balance',
      membership: nativeMembership(),
      properties: {
        id: objectId({ id: 'balance.id' }),
        account: native(z.int64(), { id: 'balance.account' }),
        total: native(z.int64().nullable(), { id: 'balance.total' }),
        count: native(z.int32(), { id: 'balance.count' }),
      },
    });
    const RecordBalance = defineAction({
      id: 'record',
      input: z.object({ total: z.int64().nullable(), count: z.int32() }),
      output: z.object({
        id: referenceInput(Balance),
        total: z.int64().nullable(),
      }),
      creates: [Balance],
      policy: { execute: access.role('editor') },
    });
    const graph = defineGraph({
      id: 'integer-properties',
      access,
      objects: { Balance },
      actions: { record: RecordBalance },
      policies: {
        Balance: {
          read: {
            gate: access.role('editor'),
            where: { account: { eq: access.claims.account } },
            evidenceMaxAgeMs: 60000,
          },
          create: { gate: access.role('editor') },
        },
      },
    });
    let calls = 0;
    const runtime = createRuntime({
      graph,
      graphId: randomUUID(),
      store: backing.store,
      bindings: [],
      cursorKey: new Uint8Array(32).fill(42),
      actionImplementations: [
        implementAction(
          graph,
          RecordBalance,
          async ({ input, objects, actor }) => {
            calls++;
            const row = await objects.Balance.create({
              ...input,
              account: actor.claims.account as string,
            });

            return { id: row.id, total: input.total };
          },
        ),
      ],
    });

    try {
      const actor = runtime.as({
        id: 'editor',
        roles: ['editor'],
        claims: { account: '9007199254740993' },
      });
      const inputs = [
        { total: '9007199254740993', count: 2147483647 },
        { total: '9007199254740992', count: -2147483648 },
        { total: '100', count: 0 },
        { total: '20', count: 1 },
        { total: '-9223372036854775808', count: 2 },
        { total: null, count: 3 },
      ];

      for (const input of inputs) {
        const request = { input, idempotencyKey: randomUUID() };
        const receipt = await actor.actions.record(request);

        expect(receipt.output.total).toBe(input.total);
        expect(await actor.actions.record(request)).toEqual(receipt);
        const result = await actor.objects.Balance.get(receipt.output.id, {
          evidence: 'full',
        });

        expect(result).toMatchObject({
          status: 'ok',
          data: { ...input, account: '9007199254740993' },
        });
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        expect(
          await runtime
            .as({
              id: 'other',
              roles: ['editor'],
              claims: { account: '9007199254740992' },
            })
            .objects.Balance.get(receipt.output.id),
        ).toEqual({ status: 'not-found' });
      }

      expect(calls).toBe(inputs.length);
      const query = {
        select: ['total'],
        where: { total: { gt: '20' } },
        limit: 1,
      } as const;
      const first = await actor.objects.Balance.query(query);

      expect(first.meta.exhausted).toBe(false);
      const values: (string | null | undefined)[] = [];

      for await (const row of actor.objects.Balance.query(query))
        values.push(row.data.total);

      expect(values.sort()).toEqual([
        '100',
        '9007199254740992',
        '9007199254740993',
      ]);
      expect(
        (
          await actor.objects.Balance.query({
            where: { total: { gt: '9007199254740992' } },
          })
        ).data.map((row) => row.data.total),
      ).toEqual(['9007199254740993']);

      for (const input of [
        { total: '9223372036854775808', count: 0 },
        { total: '-0', count: 0 },
        { total: '1', count: 2147483648 },
        { total: '1', count: 0.5 },
      ])
        await expect(
          actor.actions.record({ input, idempotencyKey: randomUUID() }),
        ).rejects.toMatchObject({ code: 'invalid' });

      expect(calls).toBe(inputs.length);
      const description = await actor.objects.Balance.describe();

      expect(
        description!.properties.find((property) => property.name === 'total'),
      ).toMatchObject({
        schema: { type: 'string', format: 'int64' },
        filterOperators: ['eq', 'in', 'gt', 'gte', 'lt', 'lte'],
      });
    } finally {
      await runtime.close();
      await backing.close();
    }
  });
}
