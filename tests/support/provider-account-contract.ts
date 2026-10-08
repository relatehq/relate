import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/runtime';
import type { ObservationStore } from '@relate/runtime/storage';
import { SourceAccessDenied } from 'relate/connectors';
import type {
  SourceBinding,
  ApplicationSourceConnector,
  SourceConnector,
} from 'relate/connectors';
import {
  Customer,
  customerGraph,
  employee,
} from '../../examples/04-postgres-persistence/src/model.js';

export function providerAccountContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let graphId: string;
    let account: string;
    let responseAccount: string | undefined;
    let recordName: string;
    let now: number;
    const identify = vi.fn(async () => account);
    const fetch = vi.fn(async () => ({
      providerAccountId: responseAccount,
      state: 'present' as const,
      record: {
        id: '1',
        display_name: recordName,
        portfolio: 'portfolio_north',
        revenue: 10,
      },
    }));
    const runtime = (providerAccountId = 'account-a') =>
      createRuntime({
        model: compile(customerGraph),
        graphId,
        store: backing.store,
        clock: () => now,
        sources: {
          'crm.customers': {
            connectionId: 'reused-connection',
            providerAccountId,
            authorization: 'shared-service',
            // Deliberately allow malformed provider identity in regression cases.
            connector: { identify, fetch: fetch as SourceConnector['fetch'] },
          },
        },
      });

    const application = (connectionId = 'reused-connection') =>
      createRuntime({
        model: compile(customerGraph),
        graphId,
        store: backing.store,
        clock: () => now,
        sources: {
          'crm.customers': {
            connectionId,
            authorization: 'shared-service',
            connector: applicationConnector,
          },
        },
      });
    const applicationFetch = vi.fn(async () => ({
      state: 'present' as const,
      record: {
        id: '1',
        display_name: recordName,
        portfolio: 'portfolio_north',
        revenue: 10,
      },
    }));
    const applicationConnector: ApplicationSourceConnector = {
      identity: 'application',
      fetch: applicationFetch,
    };

    beforeEach(async () => {
      backing = await open();
      graphId = randomUUID();
      account = responseAccount = 'account-a';
      recordName = 'Account A customer';
      now = 1_000;
      identify.mockReset().mockImplementation(async () => account);
      fetch.mockClear();
      applicationFetch.mockClear();
    });
    afterEach(async () => {
      await backing?.close();
    });

    it('reuses application identity across runtimes but separates connections and verification modes', async () => {
      const id = await application().adopt(Customer.id, '1');

      expect(await application().adopt(Customer.id, '1')).toBe(id);
      expect(await application().read(employee, Customer.id, id)).toMatchObject(
        { data: { name: recordName } },
      );
      expect(identify).not.toHaveBeenCalled();
      expect(
        await application('another').read(employee, Customer.id, id),
      ).toEqual({ status: 'not-found' });
      expect(await application('another').adopt(Customer.id, '1')).not.toBe(id);
      expect(await runtime().read(employee, Customer.id, id)).toEqual({
        status: 'not-found',
      });
      const verified = await runtime().adopt(Customer.id, '1');

      expect(verified).not.toBe(id);
      expect(await application().read(employee, Customer.id, verified)).toEqual(
        { status: 'not-found' },
      );
    });

    it('keeps explicit denial from falling back in application mode', async () => {
      const current = application();
      const id = await current.adopt(Customer.id, '1');

      applicationFetch.mockRejectedValueOnce(new SourceAccessDenied());
      expect(
        await current.read(employee, Customer.id, id, { refresh: true }),
      ).toEqual({ status: 'not-found' });
      expect(await current.read(employee, Customer.id, id)).toMatchObject({
        data: { name: recordName },
      });
    });

    it('rejects an expected provider account on an application-owned connector', () => {
      expect(() =>
        createRuntime({
          model: compile(customerGraph),
          graphId,
          sources: {
            'crm.customers': {
              connectionId: 'x',
              authorization: 'shared-service',
              providerAccountId: 'fake',
              connector: applicationConnector,
            } as unknown as SourceBinding,
          },
        }),
      ).toThrow('unsupported source binding');
    });

    it.each([{}, { refresh: true }, { select: ['id'] }])(
      'withholds old IDs after credentials switch even on an existing runtime: %j',
      async (request) => {
        const original = runtime();
        const id = await original.adopt(Customer.id, '1');

        account = responseAccount = 'account-b';
        recordName = 'Account B customer';
        fetch.mockClear();
        expect(await original.read(employee, Customer.id, id, request)).toEqual(
          { status: 'not-found' },
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(
          await runtime().read(employee, Customer.id, id, request),
        ).toEqual({ status: 'not-found' });
      },
    );

    it('gives another verified account a separate identity under the same connection ID', async () => {
      const idA = await runtime().adopt(Customer.id, '1');

      account = responseAccount = 'account-b';
      recordName = 'Account B customer';
      const second = runtime('account-b');

      expect(await second.read(employee, Customer.id, idA)).toEqual({
        status: 'not-found',
      });
      expect(
        await second.read(employee, Customer.id, idA, { refresh: true }),
      ).toEqual({ status: 'not-found' });
      const idB = await second.adopt(Customer.id, '1');

      expect(idB).not.toBe(idA);
      expect(await second.read(employee, Customer.id, idB)).toMatchObject({
        data: { name: 'Account B customer' },
      });
      account = responseAccount = 'account-a';
      expect(await runtime().read(employee, Customer.id, idA)).toMatchObject({
        data: { name: 'Account A customer' },
      });
      expect(await runtime().adopt(Customer.id, '1')).toBe(idA);
    });

    it.each(['account-b', undefined])(
      'rejects mismatched or missing response identity (%s) without retaining or falling back',
      async (identity) => {
        const original = runtime();
        const id = await original.adopt(Customer.id, '1');

        responseAccount = identity;
        recordName = 'Wrong customer';
        expect(
          await original.read(employee, Customer.id, id, { refresh: true }),
        ).toEqual({ status: 'not-found' });
        await expect(original.adopt(Customer.id, '1')).rejects.toThrow();
        responseAccount = 'account-a';
        expect(await original.read(employee, Customer.id, id)).toMatchObject({
          data: { name: 'Account A customer' },
        });
      },
    );

    it('does not adopt under an unverified configured account', async () => {
      account = responseAccount = 'account-b';
      await expect(runtime().adopt(Customer.id, '1')).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('withholds cache when identity cannot be verified and retries verification on recovery', async () => {
      const original = runtime();
      const id = await original.adopt(Customer.id, '1');

      identify.mockRejectedValueOnce(new Error('private credentials'));
      await expect(
        original.read(employee, Customer.id, id),
      ).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
      expect(await original.read(employee, Customer.id, id)).toMatchObject({
        data: { name: 'Account A customer' },
      });
    });

    it('bounds identity verification even for a fresh cached read', async () => {
      const original = runtime();
      const id = await original.adopt(Customer.id, '1');

      identify.mockImplementationOnce(() => new Promise(() => {}));
      await expect(
        original.read(employee, Customer.id, id, { timeoutMs: 10 }),
      ).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('does not use stale fallback when credentials switch during a failed fetch', async () => {
      const original = runtime();
      const id = await original.adopt(Customer.id, '1');

      fetch.mockImplementationOnce(async () => {
        account = 'account-b';
        throw new Error('Record endpoint unavailable');
      });
      expect(
        await original.read(employee, Customer.id, id, { refresh: true }),
      ).toEqual({ status: 'not-found' });
    });

    it('rechecks permission freshness after the final account verification', async () => {
      const original = runtime();
      const id = await original.adopt(Customer.id, '1');

      identify
        .mockImplementationOnce(async () => account)
        .mockImplementationOnce(async () => {
          now += 30_001;

          return account;
        });
      expect(await original.read(employee, Customer.id, id)).toEqual({
        status: 'not-found',
      });
    });
  });
}
