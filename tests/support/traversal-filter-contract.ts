import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  connect,
  defineAccess,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';
import type { SourceConnector } from 'relate/connectors';
import type { ObservationStore } from 'relate/storage';
import { createRuntime } from '@relate/node';

type Backing = { store: ObservationStore; close(): Promise<void> };

/** People receive transactions by reference and belong to groups through memberships. */
function createLedgerGraph(membershipEvidenceMaxAgeMs = 300_000) {
  const timestamp = z.iso.datetime({ offset: true, precision: 3 });
  const access = defineAccess({
    roles: ['reader', 'auditor'],
    fieldGroups: ['ordinary', 'private'],
    claims: { visible: z.boolean() },
  });
  const people = defineSource({
    id: 'ledger.people',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      name: z.string(),
      visible: z.boolean(),
    }),
  });
  const transactions = defineSource({
    id: 'ledger.transactions',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      sender: z.string(),
      receiver: z.string(),
      amount: z.number(),
      createdAt: timestamp,
      note: z.string(),
      visible: z.boolean(),
    }),
  });
  const groups = defineSource({
    id: 'ledger.groups',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      name: z.string(),
      visible: z.boolean(),
    }),
  });
  const memberships = defineSource({
    id: 'ledger.memberships',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      group: z.string(),
      person: z.string(),
      visible: z.boolean(),
    }),
  });
  const Person = defineObject({
    id: 'person',
    membership: source(people),
    properties: {
      id: objectId({ id: 'person.id' }),
      name: from(people.fields.name, { id: 'person.name' }),
      visible: from(people.fields.visible, { id: 'person.visible' }),
    },
  });
  const Transaction = defineObject({
    id: 'transaction',
    membership: source(transactions),
    properties: {
      id: objectId({ id: 'transaction.id' }),
      sender: reference(Person, {
        id: 'transaction.sender',
        from: transactions.fields.sender,
      }),
      receiver: reference(Person, {
        id: 'transaction.receiver',
        from: transactions.fields.receiver,
      }),
      amount: from(transactions.fields.amount, { id: 'transaction.amount' }),
      createdAt: from(transactions.fields.createdAt, {
        id: 'transaction.createdAt',
      }),
      note: from(transactions.fields.note, {
        id: 'transaction.note',
        access: access.groups.private,
      }),
      visible: from(transactions.fields.visible, {
        id: 'transaction.visible',
      }),
    },
  });
  const Group = defineObject({
    id: 'group',
    membership: source(groups),
    properties: {
      id: objectId({ id: 'group.id' }),
      name: from(groups.fields.name, { id: 'group.name' }),
      visible: from(groups.fields.visible, { id: 'group.visible' }),
    },
  });
  const Membership = defineObject({
    id: 'membership',
    membership: source(memberships),
    properties: {
      id: objectId({ id: 'membership.id' }),
      group: reference(Group, {
        id: 'membership.group',
        from: memberships.fields.group,
      }),
      person: reference(Person, {
        id: 'membership.person',
        from: memberships.fields.person,
      }),
      visible: from(memberships.fields.visible, { id: 'membership.visible' }),
    },
  });
  const Received = defineRelationship({
    id: 'person.received',
    forward: 'receivedTransactions',
    reverse: 'receiver',
    via: Transaction.properties.receiver,
  });
  const Members = defineRelationship({
    id: 'group.members',
    forward: 'members',
    reverse: 'groups',
    through: {
      from: Membership.properties.group,
      to: Membership.properties.person,
    },
  });
  const policy = {
    read: {
      gate: access.role('reader'),
      where: { visible: { eq: access.claims.visible } },
      // Outlives field freshness, so stale filter evidence stays distinct
      // from expired authorization.
      evidenceMaxAgeMs: 300_000,
    },
    groups: { private: access.role('auditor') },
  };
  const graph = defineGraph({
    id: 'ledger',
    access,
    objects: { Person, Transaction, Group, Membership },
    relationships: { Received, Members },
    policies: {
      Person: policy,
      Transaction: policy,
      Group: policy,
      Membership: {
        ...policy,
        read: { ...policy.read, evidenceMaxAgeMs: membershipEvidenceMaxAgeMs },
      },
    },
  });

  return {
    graph,
    Person,
    Transaction,
    Group,
    Membership,
    people,
    transactions,
    groups,
    memberships,
  };
}

const start = '2026-10-01T00:00:00.000Z';
const end = '2026-11-01T00:00:00.000Z';

export function traversalFilterContract(
  name: string,
  open: () => Promise<Backing>,
) {
  describe(name, () => {
    const cleanup: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const close of cleanup.splice(0).reverse()) await close();
    });

    async function setup(membershipEvidenceMaxAgeMs = 300_000) {
      const model = createLedgerGraph(membershipEvidenceMaxAgeMs);
      const backing = await open();

      cleanup.push(backing.close);
      const rows = {
        people: new Map<string, Record<string, string | number | boolean>>(),
        transactions: new Map<
          string,
          Record<string, string | number | boolean>
        >(),
        groups: new Map<string, Record<string, string | number | boolean>>(),
        memberships: new Map<
          string,
          Record<string, string | number | boolean>
        >(),
      };
      const offline = new Set<keyof typeof rows>();
      const hooks: {
        onFetch?: (type: keyof typeof rows, id: string) => void;
      } = {};
      let now = 1_000;
      const connector = (type: keyof typeof rows): SourceConnector => ({
        identify: async () => 'ledger',
        async fetch(id) {
          if (offline.has(type)) throw new Error('offline');

          hooks.onFetch?.(type, id);
          const record = rows[type].get(id);

          return record
            ? { providerAccountId: 'ledger', state: 'present', record }
            : { providerAccountId: 'ledger', state: 'deleted' };
        },
      });
      const fetches = {
        people: vi.fn(connector('people').fetch),
        transactions: vi.fn(connector('transactions').fetch),
        groups: vi.fn(connector('groups').fetch),
        memberships: vi.fn(connector('memberships').fetch),
      };
      const runtime = createRuntime({
        graph: model.graph,
        graphId: randomUUID(),
        store: backing.store,
        clock: () => now,
        connections: (
          ['people', 'transactions', 'groups', 'memberships'] as const
        ).map((type) =>
          connect(model[type], {
            providerAccountId: 'ledger',
            connectionId: type,
            connector: {
              identify: async () => 'ledger',
              fetch: fetches[type],
            },
          }),
        ),
      });

      cleanup.push(() => runtime.close());
      const person = (id: string, name = id, visible = true) => {
        rows.people.set(id, { id, name, visible });

        return runtime.host.adopt(model.Person, id);
      };
      const transaction = (
        id: string,
        values: {
          sender: string;
          receiver: string;
          createdAt: string;
          amount?: number;
          visible?: boolean;
        },
      ) => {
        rows.transactions.set(id, {
          id,
          amount: 10,
          note: `note ${id}`,
          visible: true,
          ...values,
        });

        return runtime.host.adopt(model.Transaction, id);
      };
      const group = (id: string, name = id) => {
        rows.groups.set(id, { id, name, visible: true });

        return runtime.host.adopt(model.Group, id);
      };
      const member = (id: string, group: string, person: string) => {
        rows.memberships.set(id, { id, group, person, visible: true });

        return runtime.host.adopt(model.Membership, id);
      };

      return {
        ...model,
        runtime,
        store: backing.store,
        rows,
        offline,
        hooks,
        fetches,
        person,
        transaction,
        group,
        member,
        reader: runtime.as({
          id: 'reader',
          roles: ['reader'],
          claims: { visible: true },
        }).objects,
        auditor: runtime.as({
          id: 'auditor',
          roles: ['reader', 'auditor'],
          claims: { visible: true },
        }).objects,
        advance: (ms: number) => {
          now += ms;
        },
      };
    }

    it('filters reference traversal members by destination properties within the relationship', async () => {
      const { person, transaction, reader } = await setup();
      const me = await person('me');
      const other = await person('other');
      const [co1, co2] = [await person('co1'), await person('co2')];

      await person('stranger');
      const included = [
        await transaction('t1', {
          sender: 'co1',
          receiver: 'me',
          createdAt: '2026-10-05T12:00:00.000Z',
        }),
        await transaction('t2', {
          sender: 'co2',
          receiver: 'me',
          createdAt: '2026-10-20T00:00:00.000Z',
        }),
        // The window start, written in another offset.
        await transaction('t3', {
          sender: 'co1',
          receiver: 'me',
          createdAt: '2026-10-01T01:00:00.000+01:00',
        }),
      ];

      for (const [id, values] of [
        [
          'wrong-sender',
          { sender: 'stranger', createdAt: '2026-10-06T00:00:00.000Z' },
        ],
        ['before', { sender: 'co1', createdAt: '2026-09-30T23:59:59.999Z' }],
        ['at-end', { sender: 'co1', createdAt: end }],
      ] as const)
        await transaction(id, { ...values, receiver: 'me' });

      await transaction('elsewhere', {
        sender: 'co1',
        receiver: 'other',
        createdAt: '2026-10-07T00:00:00.000Z',
      });

      const rows = [];

      for await (const row of reader.Person.traverse.receivedTransactions(me, {
        where: {
          sender: { in: [co1, co2] },
          createdAt: { gte: start, lt: end },
        },
        select: ['sender', 'amount', 'createdAt'],
        limit: 1,
      }))
        rows.push(row);

      expect(rows.map((row) => row.id).sort()).toEqual([...included].sort());
      expect(Object.keys(rows[0]!.data).sort()).toEqual([
        'amount',
        'createdAt',
        'sender',
      ]);
      expect(
        (await reader.Person.traverse.receivedTransactions(me, { limit: 100 }))
          .data,
      ).toHaveLength(6);
      expect(
        (
          await reader.Person.traverse.receivedTransactions(other, {
            where: { sender: co1 },
          })
        ).data,
      ).toHaveLength(1);
    });

    it('filters through destinations, deduplicating links and paging in destination order', async () => {
      const { person, group, member, reader } = await setup();
      const g = await group('g', 'Team');
      const h = await group('h', 'Guild');
      const ids = {
        a: await person('a', 'Ada'),
        b: await person('b', 'Bo'),
        c: await person('c', 'Cy'),
        d: await person('d', 'Di'),
      };

      await member('m1', 'g', 'a');
      await member('m2', 'g', 'a');
      await member('m3', 'g', 'b');
      await member('m4', 'g', 'c');
      await member('m5', 'g', 'd');
      await member('m6', 'h', 'b');
      await member('m7', 'h', 'c');

      const pages = [];
      let cursor: string | undefined;

      do {
        const page = await reader.Group.traverse.members(g, {
          where: { name: { in: ['Ada', 'Cy', 'Di'] } },
          select: ['name'],
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });

        pages.push(page.data.map((row) => row.id));
        cursor = page.meta.continuationCursor;
      } while (cursor);

      const returned = pages.flat();

      // Only matching destinations enter a pass, so no page is spent on b.
      expect(pages.map((page) => page.length)).toEqual([1, 1, 1]);
      expect(returned.sort()).toEqual([ids.a, ids.c, ids.d].sort());
      expect(new Set(returned).size).toBe(returned.length);
      expect(
        (
          await reader.Person.traverse.groups(ids.b, {
            where: { name: 'Guild' },
            select: ['name'],
          })
        ).data,
      ).toMatchObject([{ id: h, data: { name: 'Guild' } }]);
      expect(
        await reader.Group.traverse.members(g, { where: { name: { in: [] } } }),
      ).toEqual({ data: [], meta: { exhausted: true } });
    });

    it('validates filters before reading roots, memberships or destinations', async () => {
      const { reader, auditor, fetches, store, person, transaction } =
        await setup();
      const scan = vi.spyOn(store, 'scan');
      const unknown = 'missing' as never;

      for (const [call, path] of [
        [
          () =>
            reader.Person.traverse.receivedTransactions(unknown, {
              where: { note: 'x' },
            } as never),
          ['where', 'note'],
        ],
        [
          () =>
            reader.Person.traverse.receivedTransactions(unknown, {
              where: { amount: '10' },
            } as never),
          ['where', 'amount'],
        ],
        [
          () =>
            reader.Person.traverse.receivedTransactions(unknown, {
              where: { createdAt: { gte: '2026-10-01' } },
            } as never),
          ['where', 'createdAt', 'gte'],
        ],
        [
          () =>
            reader.Group.traverse.members(unknown, {
              where: { person: 'x' },
            } as never),
          ['where', 'person'],
        ],
        [
          () =>
            reader.Group.traverse.members(unknown, {
              where: { name: { gt: 'A' } },
            } as never),
          ['where', 'name', 'gt'],
        ],
        [
          () =>
            reader.Transaction.traverse.receiver(unknown, {
              where: { name: 'me' },
            } as never),
          ['where'],
        ],
      ] as const)
        await expect(call()).rejects.toMatchObject({
          code: 'invalid-request',
          issues: [expect.objectContaining({ path })],
        });

      expect(scan).not.toHaveBeenCalled();

      for (const fetch of Object.values(fetches))
        expect(fetch).not.toHaveBeenCalled();

      // A field group the auditor may read is filterable for the auditor.
      const me = await person('me');

      await person('co');
      const t = await transaction('t', {
        sender: 'co',
        receiver: 'me',
        createdAt: start,
      });

      expect(
        (
          await auditor.Person.traverse.receivedTransactions(me, {
            where: { note: 'note t' },
            select: [],
          })
        ).data.map((row) => row.id),
      ).toEqual([t]);
    });

    it('binds cursors to normalized filters', async () => {
      const { person, transaction, group, member, reader } = await setup();
      const me = await person('me');
      const [co1, co2] = [await person('co1'), await person('co2')];

      for (const id of ['t1', 't2', 't3'])
        await transaction(id, {
          sender: id === 't2' ? 'co2' : 'co1',
          receiver: 'me',
          createdAt: '2026-10-02T00:00:00.000Z',
        });

      const first = await reader.Person.traverse.receivedTransactions(me, {
        where: { createdAt: { gte: start }, sender: { in: [co1, co2, co1] } },
        limit: 1,
      });
      const cursor = first.meta.continuationCursor!;

      expect(cursor).toBeDefined();

      const next = await reader.Person.traverse.receivedTransactions(me, {
        where: {
          sender: { in: [co2, co1] },
          createdAt: { gte: '2026-10-01T01:00:00+01:00' },
        },
        limit: 1,
        cursor,
      });

      expect(next.data).toHaveLength(1);
      expect(next.data[0]!.id).not.toBe(first.data[0]!.id);

      for (const where of [
        {
          createdAt: { gte: '2026-10-01T00:00:00.001Z' },
          sender: { in: [co1, co2] },
        },
        { sender: { in: [co1, co2] } },
        undefined,
      ])
        await expect(
          reader.Person.traverse.receivedTransactions(me, {
            ...(where ? { where } : {}),
            limit: 1,
            cursor,
          }),
        ).rejects.toMatchObject({
          code: 'invalid-request',
          issues: [{ path: ['cursor'], problem: 'invalid-cursor' }],
        });

      const g = await group('g');

      for (const id of ['a', 'b', 'c']) {
        await person(id);
        await member(`m-${id}`, 'g', id);
      }

      const members = await reader.Group.traverse.members(g, {
        where: { name: { in: ['a', 'b', 'c'] } },
        limit: 1,
      });

      await expect(
        reader.Group.traverse.members(g, {
          limit: 1,
          cursor: members.meta.continuationCursor!,
        }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
      expect(
        (
          await reader.Group.traverse.members(g, {
            where: { name: { in: ['c', 'b', 'a'] } },
            limit: 1,
            cursor: members.meta.continuationCursor!,
          })
        ).data,
      ).toHaveLength(1);
    });

    it('refreshes cached non-matches and reports unusable filter evidence as incomplete', async () => {
      const {
        person,
        transaction,
        group,
        member,
        reader,
        rows,
        offline,
        advance,
      } = await setup();
      const me = await person('me');

      await person('co');
      const t = await transaction('t', {
        sender: 'co',
        receiver: 'me',
        createdAt: start,
      });
      const g = await group('g');
      const c = await person('c', 'Cy');

      await member('m', 'g', 'c');

      expect(
        (
          await reader.Person.traverse.receivedTransactions(me, {
            where: { amount: { gt: 50 } },
          })
        ).data,
      ).toEqual([]);
      expect(
        (await reader.Group.traverse.members(g, { where: { name: 'Cyd' } }))
          .data,
      ).toEqual([]);

      rows.transactions.get('t')!.amount = 100;
      rows.people.get('c')!.name = 'Cyd';

      expect(
        (
          await reader.Person.traverse.receivedTransactions(me, {
            where: { amount: { gt: 50 } },
            refresh: true,
          })
        ).data.map((row) => row.id),
      ).toEqual([t]);
      expect(
        (
          await reader.Group.traverse.members(g, {
            where: { name: 'Cyd' },
            refresh: true,
          })
        ).data.map((row) => row.id),
      ).toEqual([c]);

      advance(61_000);
      offline.add('transactions');
      await expect(
        reader.Person.traverse.receivedTransactions(me, {
          where: { amount: { gt: 50 } },
          stale: 'omit',
        }),
      ).rejects.toMatchObject({ code: 'incomplete' });
      offline.clear();
      offline.add('people');
      await expect(
        reader.Group.traverse.members(g, {
          where: { name: 'Cyd' },
          stale: 'omit',
        }),
      ).rejects.toMatchObject({ code: 'incomplete' });
    });

    it('withholds matching members hidden by record policy', async () => {
      const { person, transaction, group, member, reader } = await setup();
      const me = await person('me');

      await person('co');
      const shown = await transaction('shown', {
        sender: 'co',
        receiver: 'me',
        createdAt: start,
      });

      await transaction('hidden', {
        sender: 'co',
        receiver: 'me',
        createdAt: start,
        visible: false,
      });
      const g = await group('g');
      const a = await person('a', 'Ada');

      await person('b', 'Ada', false);
      await member('m-a', 'g', 'a');
      await member('m-b', 'g', 'b');

      expect(
        (
          await reader.Person.traverse.receivedTransactions(me, {
            where: { createdAt: start },
          })
        ).data.map((row) => row.id),
      ).toEqual([shown]);
      expect(
        (
          await reader.Group.traverse.members(g, { where: { name: 'Ada' } })
        ).data.map((row) => row.id),
      ).toEqual([a]);
    });

    it('withholds a through member when its final filter refresh outlives junction authorization', async () => {
      const { person, group, member, reader, store, hooks, fetches, advance } =
        await setup(50);
      const g = await group('g');

      await person('p', 'Ada');
      await member('m', 'g', 'p');
      fetches.people.mockClear();

      // The final root read takes 45ms. Filter evidence (10ms) expires,
      // but the junction policy evidence (50ms) still permits the member.
      // Source-key resolution uses resolve(); the two canonical root loads
      // are the initial root read and its final authorization read.
      const load = store.load.bind(store);
      let rootLoads = 0;
      const loadSpy = vi
        .spyOn(store, 'load')
        .mockImplementation(async (scope, id) => {
          if (
            scope.objectDefinitionId === 'group' &&
            id === g &&
            ++rootLoads === 2
          )
            advance(45);

          return load(scope, id);
        });

      // Confirming the expired filter refreshes Ada and takes another 10ms.
      // Her name still matches and her own policy remains valid, but the
      // junction evidence is now 55ms old and cannot authorize disclosure.
      hooks.onFetch = (type) => {
        if (type === 'people') advance(10);
      };

      try {
        const page = await reader.Group.traverse.members(g, {
          where: { name: 'Ada' },
          select: ['name'],
          maxAgeMs: 10,
          stale: 'omit',
        });

        expect(rootLoads).toBe(2);
        expect(fetches.people).toHaveBeenCalledTimes(1);
        expect(page).toEqual({ data: [], meta: { exhausted: true } });
      } finally {
        loadSpy.mockRestore();
      }
    });

    it('withholds a member that stops matching after its filter evidence expires', async () => {
      const { person, transaction, reader, rows, hooks, advance } =
        await setup();
      const me = await person('me');

      await person('co');
      const ids = new Map<string, string>();

      for (const id of ['t1', 't2'])
        ids.set(
          id,
          await transaction(id, {
            sender: 'co',
            receiver: 'me',
            createdAt: start,
            amount: 100,
          }),
        );

      advance(61_000);
      const fetched: string[] = [];

      // Members are read in turn; observations are timed when a read starts.
      // Reading the first takes 40s and the second 25s, so the first member
      // matches when read but its evidence ages out before the page is emitted,
      // after its source value changed.
      hooks.onFetch = (type, id) => {
        if (type !== 'transactions') return;

        const count = fetched.push(id);

        if (count === 1) advance(40_000);

        if (count === 2) {
          advance(25_000);
          rows.transactions.get(fetched[0]!)!.amount = 10;
        }
      };

      const page = await reader.Person.traverse.receivedTransactions(me, {
        where: { amount: { gt: 50 } },
        stale: 'omit',
        select: [],
      });

      expect(page.data.map((row) => row.id)).toEqual([ids.get(fetched[1]!)]);
    });
  });
}
