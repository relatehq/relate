import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  bind,
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
  reference,
  referenceInput,
  source,
} from 'relate';
import type { ActionContext, ObjectId } from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { SourceAccessDenied } from 'relate/connectors';
import type { FeedEntry } from '@relate/protocol';
import type {
  NativeTransaction,
  ObservationStore,
  StorageScope,
} from '@relate/runtime/storage';

const access = defineAccess({
  roles: ['employee'],
  fieldGroups: ['ordinary'],
  claims: { portfolio: z.string() },
});

const groups = defineSource({
  id: 'platform.ad-groups',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    budget: z.number(),
    portfolio: z.string(),
  }),
});

export const AdGroup = defineObject({
  id: 'ads.ad-group',
  membership: source(groups),
  properties: {
    id: objectId({ id: 'group.id' }),
    name: from(groups.fields.name, { id: 'group.name' }),
    budget: from(groups.fields.budget, { id: 'group.budget' }),
    portfolio: from(groups.fields.portfolio, { id: 'group.portfolio' }),
  },
});

export const Launch = defineObject({
  id: 'ads.launch',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'launch.id' }),
    group: reference(AdGroup, { id: 'launch.group' }),
    note: native(z.string(), { id: 'launch.note' }),
  },
});

export const LaunchAdGroup = defineAction({
  id: 'ads.launch-ad-group',
  description:
    'Create an ad group on the platform and bring it into the graph.',
  input: z.object({ name: z.string(), budget: z.number() }),
  output: z.object({ groupId: referenceInput(AdGroup) }),
  creates: [Launch],
  adopts: [AdGroup],
  errors: {
    notVisible: z.object({ externalId: z.string() }),
    rejected: z.object({}),
    rejectedGroup: z.object({ group: referenceInput(AdGroup) }),
  },
  policy: { execute: access.role('employee') },
});

export const RenameLaunch = defineAction({
  id: 'ads.rename-launch',
  input: z.object({ note: z.string() }),
  output: z.object({}),
  policy: { execute: access.role('employee') },
});

const policy = {
  read: {
    gate: access.role('employee'),
    where: { portfolio: { eq: access.claims.portfolio } },
    evidenceMaxAgeMs: 30_000,
  },
};

export const adoptionGraph = defineGraph({
  id: 'action-adoption',
  objects: { AdGroup, Launch },
  actions: { launch: LaunchAdGroup, rename: RenameLaunch },
  access,
  policies: {
    AdGroup: policy,
    Launch: {
      read: {
        gate: access.role('employee'),
        where: { group: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
      create: {
        gate: access.role('employee'),
        where: { group: { portfolio: { eq: access.claims.portfolio } } },
        evidenceMaxAgeMs: 30_000,
      },
    },
  },
});

const ana = { id: 'ana', roles: ['employee'], claims: { portfolio: 'north' } };

type Context = ActionContext<typeof adoptionGraph, typeof LaunchAdGroup>;

type Handler = (
  context: Context,
) => Promise<z.input<typeof LaunchAdGroup.output>>;

interface PlatformRecord {
  name: string;
  budget: number;
  portfolio: string;
  state: 'present' | 'deleted';
  /** A new record's ID is served before the read API can return it. */
  visible: boolean;
  invalid?: boolean;
}

/** A test-owned ad platform: creates records and serves them by ID. */
function createPlatform() {
  const records = new Map<string, PlatformRecord>();
  let created = 0;
  let account = 'adv_42';
  let fetches = 0;

  return {
    records,
    get created() {
      return created;
    },
    get fetches() {
      return fetches;
    },
    deny() {
      account = 'adv_other';
    },
    create(name: string, budget: number, portfolio = 'north', visible = true) {
      created++;
      const id = `tt_${randomUUID()}`;

      records.set(id, { name, budget, portfolio, state: 'present', visible });

      return id;
    },
    /** Integration polling, outside any context call. */
    async waitUntilVisible(id: string, attempts: number) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (records.get(id)?.visible) return true;

        records.get(id)!.visible = attempt + 1 >= attempts - 1;
      }

      return Boolean(records.get(id)?.visible);
    },
    connector: {
      identify: async () => account,
      fetch: async (id: string) => {
        fetches++;
        const record = records.get(id);

        if (account !== 'adv_42') throw new SourceAccessDenied();

        if (!record?.visible) throw new Error('404 Not Found');

        if (record.state === 'deleted')
          return { providerAccountId: account, state: 'deleted' as const };

        return {
          providerAccountId: account,
          state: 'present' as const,
          record: record.invalid
            ? { id, name: record.name }
            : {
                id,
                name: record.name,
                budget: record.budget,
                portfolio: record.portfolio,
              },
        };
      },
    },
  };
}

/**
 * The test integration's journal: it lives outside every action transaction,
 * so a rollback never erases the record of an external create.
 */
function createJournal() {
  const operations = new Map<string, string>();

  return {
    operations,
    async once(idempotencyId: string, create: () => string) {
      const recorded = operations.get(idempotencyId);

      if (recorded) return recorded;

      const id = create();

      operations.set(idempotencyId, id);

      return id;
    },
  };
}

export function adoptionActionContract(
  name: string,
  open: () => Promise<{
    store: ObservationStore;
    kind: 'memory' | 'postgres';
    close(): Promise<void>;
    reopen?(): Promise<ObservationStore & { close(): Promise<void> }>;
  }>,
) {
  describe(name, () => {
    let backing: Awaited<ReturnType<typeof open>>;
    let graphId: string;
    let now: number;
    let platform: ReturnType<typeof createPlatform>;
    let journal: ReturnType<typeof createJournal>;
    const model = compile(adoptionGraph);
    const scope = (): StorageScope => ({
      graphId,
      definitionRevision: model.definitionRevision,
      objectDefinitionId: AdGroup.id,
      sourceDefinitionId: groups.id,
      connectionId: 'tiktok',
      resourceId: 'ad-groups',
      providerAccountId: 'adv_42',
      partition: 'shared-service',
    });

    beforeEach(async () => {
      backing = await open();
      graphId = randomUUID();
      now = 1_000_000;
      platform = createPlatform();
      journal = createJournal();
    });
    afterEach(async () => {
      await backing.close();
    });

    function app(
      handler: Handler,
      options: {
        store?: ObservationStore;
        actionTimeoutMs?: number;
        transaction?: (transaction: NativeTransaction) => NativeTransaction;
      } = {},
    ) {
      const store = options.store ?? backing.store;
      const wrap = options.transaction;

      return createRuntime({
        graph: adoptionGraph,
        graphId,
        clock: () => now,
        ...(options.actionTimeoutMs
          ? { actionTimeoutMs: options.actionTimeoutMs }
          : {}),
        store: wrap
          ? {
              ...store,
              native: {
                ...store.native!,
                transaction: (scope, operation) =>
                  store.native!.transaction(scope, (tx) => operation(wrap(tx))),
              },
            }
          : store,
        actionImplementations: [
          implementAction(adoptionGraph, LaunchAdGroup, handler),
          implementAction(adoptionGraph, RenameLaunch, async () => ({})),
        ],
        bindings: [
          bind(groups, {
            providerAccountId: 'adv_42',
            connectionId: 'tiktok',
            resourceId: 'ad-groups',
            connector: platform.connector,
          }),
        ],
      });
    }

    /** Create once per idempotency ID, then adopt the platform record. */
    const createAndAdopt: Handler = async ({
      input,
      idempotencyId,
      objects,
    }) => {
      const externalId = await journal.once(idempotencyId, () =>
        platform.create(input.name, input.budget),
      );
      const { id } = await objects.AdGroup.adopt(externalId);

      return { groupId: id };
    };

    const request = (key = 'launch', budget = 500) => ({
      input: { name: 'NL_ACME_Q4_RTG_TIKTOK', budget },
      idempotencyKey: key,
    });

    async function feed(relate: ReturnType<typeof app>) {
      return (await relate.host.activity.feed.read({ limit: 100 })).entries;
    }

    async function members() {
      const result = await backing.store.scan(scope(), { limit: 100 });

      return result.objects;
    }

    it('creates externally, adopts, reads and references the pending object, and commits it', async () => {
      const relate = app(async (context) => {
        const { input, idempotencyId, objects } = context;
        const externalId = await journal.once(idempotencyId, () =>
          platform.create(input.name, input.budget, 'north', false),
        );

        if (!(await platform.waitUntilVisible(externalId, 3)))
          return context.fail('notVisible', { externalId });

        const { id } = await objects.AdGroup.adopt(externalId);
        const group = await objects.AdGroup.get(id, { evidence: 'full' });

        expect(group).toMatchObject({
          status: 'ok',
          id,
          data: { name: input.name, budget: 500, portfolio: 'north' },
        });

        if (group.status !== 'ok') throw new Error('Expected pending group');

        // Staged data is not saved until commit.
        expect(group.meta.fields.budget).toMatchObject({
          retention: 'unconfirmed',
          ordering: 'unconfirmed',
        });
        expect(group.meta.warnings).toEqual(
          expect.arrayContaining([
            'retention_unconfirmed',
            'ordering_unconfirmed',
          ]),
        );

        const launch = await objects.Launch.create({
          group: id,
          note: 'Launched',
        });

        await expect(objects.Launch.get(launch.id)).resolves.toMatchObject({
          status: 'ok',
          data: { group: id },
        });

        return { groupId: id };
      });

      const receipt = await relate.as(ana).actions.launch(request());

      if (receipt.state !== 'succeeded') throw new Error('Expected success');

      const { groupId } = receipt.output;

      expect(platform.created).toBe(1);
      await expect(
        relate.as(ana).objects.AdGroup.get(groupId),
      ).resolves.toMatchObject({
        status: 'ok',
        id: groupId,
        data: { budget: 500, portfolio: 'north' },
      });
      expect(
        await relate.host.provenance({
          objectDefinitionId: AdGroup.id,
          objectId: groupId,
        }),
      ).toEqual({
        kind: 'adopted',
        actor: { kind: 'principal', id: 'ana' },
        at: expect.any(String),
        sourceDefinitionId: groups.id,
        invocationId: receipt.invocationId,
      });

      const entries = (await feed(relate)).filter(
        (entry) => entry.invocationId === receipt.invocationId,
      );

      expect(entries.map((entry) => entry.kind)).toEqual([
        'adopted',
        'created',
        'invocation-succeeded',
      ]);
      expect(entries[0]).toMatchObject({
        kind: 'adopted',
        object: { objectDefinitionId: AdGroup.id, objectId: groupId },
        actor: { kind: 'principal', id: 'ana' },
        sourceDefinitionId: groups.id,
      });

      // A replay returns the saved receipt without rerunning the handler.
      await expect(relate.as(ana).actions.launch(request())).resolves.toEqual(
        receipt,
      );
      expect(platform.created).toBe(1);
      await relate.close();
    });

    it('persists invocation provenance across restart, and host adoption omits it', async () => {
      const relate = app(createAndAdopt);
      const receipt = await relate.as(ana).actions.launch(request());

      if (receipt.state !== 'succeeded') throw new Error('Expected success');

      const hosted = await relate.host.adopt(
        AdGroup,
        platform.create('hosted', 1),
      );

      await relate.close();
      const reopened = await backing.reopen?.();
      const restarted = app(createAndAdopt, {
        ...(reopened ? { store: reopened } : {}),
      });

      await expect(
        restarted.host.provenance({
          objectDefinitionId: AdGroup.id,
          objectId: receipt.output.groupId,
        }),
      ).resolves.toMatchObject({ invocationId: receipt.invocationId });
      await expect(
        restarted.host.provenance({
          objectDefinitionId: AdGroup.id,
          objectId: hosted,
        }),
      ).resolves.not.toHaveProperty('invocationId');
      await restarted.close();
      await reopened?.close();
    });

    it.each([
      ['throw', async () => Promise.reject(new Error('boom'))],
      ['invalid output', async () => ({ groupId: 42 }) as never],
    ] as const)(
      'rolls back adoption when the handler fails by %s',
      async (_, finish) => {
        const relate = app(async (context) => {
          await createAndAdopt(context);

          return finish();
        });

        await expect(
          relate.as(ana).actions.launch(request()),
        ).rejects.toBeDefined();
        expect(await members()).toEqual([]);
        expect(
          (await feed(relate)).filter((entry) => entry.kind === 'adopted'),
        ).toEqual([]);
        await relate.close();
      },
    );

    it('rolls back a caught adoption failure and saves no receipt', async () => {
      const relate = app(async (context) => {
        const first = await createAndAdopt(context);

        try {
          await context.objects.AdGroup.adopt('tt_missing');
        } catch {
          // Context failures abort the invocation even when caught.
        }

        return first;
      });

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(await members()).toEqual([]);
      await expect(
        backing.store.native!.loadInvocation(
          { graphId, definitionRevision: model.definitionRevision },
          LaunchAdGroup.id,
          'launch',
        ),
      ).resolves.toBeUndefined();
      await relate.close();
    });

    it('discards staged adoptions on timeout and revokes late staging', async () => {
      let resume!: () => void;
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let late: Promise<unknown> | undefined;
      const relate = app(
        async (context) => {
          const output = await createAndAdopt(context);

          await blocked;
          late = context.objects.AdGroup.adopt(platform.create('late', 1));

          return output;
        },
        { actionTimeoutMs: 200 },
      );

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'unavailable' });
      resume();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(late).rejects.toBeDefined();
      expect(await members()).toEqual([]);
      await relate.close();
    });

    it('saves a declared failure after adopt and get without adopting the discarded member', async () => {
      let calls = 0;
      const handler: Handler = async (context) => {
        calls++;
        const { groupId } = await createAndAdopt(context);

        await context.objects.AdGroup.get(groupId);

        return context.fail('rejected', {});
      };
      const relate = app(handler);
      const receipt = await relate.as(ana).actions.launch(request());

      expect(receipt).toMatchObject({
        state: 'failed',
        error: { kind: 'domain', code: 'rejected', details: {} },
      });
      expect(await members()).toEqual([]);
      await expect(relate.as(ana).actions.launch(request())).resolves.toEqual(
        receipt,
      );
      await expect(
        relate.as(ana).receipts.get('launch', receipt.invocationId),
      ).resolves.toEqual(receipt);

      const saved = await backing.store.native!.loadInvocation(
        { graphId, definitionRevision: model.definitionRevision },
        LaunchAdGroup.id,
        'launch',
      );

      expect(saved?.reads).toEqual([]);
      expect(
        (await feed(relate))
          .filter((entry) => entry.invocationId === receipt.invocationId)
          .map((entry) => entry.kind),
      ).toEqual(['invocation-failed']);
      await relate.close();

      const reopened = await backing.reopen?.();
      const restarted = app(handler, {
        ...(reopened ? { store: reopened } : {}),
      });

      await expect(
        restarted.as(ana).actions.launch(request()),
      ).resolves.toEqual(receipt);
      expect(calls).toBe(1);
      await restarted.close();
      await reopened?.close();
    });

    it('keeps reads of existing members in a failed receipt and rejects details naming a discarded member', async () => {
      const existing = platform.create('existing', 1);
      const relate = app(async (context) => {
        const committed = await context.objects.AdGroup.adopt(existing);

        await context.objects.AdGroup.get(committed.id);

        if (context.input.name === 'details') {
          const { groupId } = await createAndAdopt(context);

          // A native record may reference the discarded adoption; it rolls back too.
          await context.objects.Launch.create({ group: groupId, note: 'x' });

          return context.fail('rejectedGroup', { group: groupId });
        }

        return context.fail('rejected', {});
      });
      const member = await relate.host.adopt(AdGroup, existing);
      const receipt = await relate.as(ana).actions.launch(request());

      expect(receipt).toMatchObject({ state: 'failed' });
      expect(
        (
          await backing.store.native!.loadInvocation(
            { graphId, definitionRevision: model.definitionRevision },
            LaunchAdGroup.id,
            'launch',
          )
        )?.reads,
      ).toEqual([
        expect.objectContaining({
          objectDefinitionId: AdGroup.id,
          objectId: member,
        }),
      ]);
      await expect(
        relate.as(ana).actions.launch({
          input: { name: 'details', budget: 1 },
          idempotencyKey: 'details',
        }),
      ).rejects.toMatchObject({ code: 'not-found' });
      await expect(
        backing.store.native!.loadInvocation(
          { graphId, definitionRevision: model.definitionRevision },
          LaunchAdGroup.id,
          'details',
        ),
      ).resolves.toBeUndefined();
      expect((await members()).map((object) => object.objectId)).toEqual([
        member,
      ]);
      await relate.close();
    });

    it('returns the first pending ID for repeated and concurrent adoption', async () => {
      const relate = app(async (context) => {
        const externalId = await journal.once(context.idempotencyId, () =>
          platform.create('group', 1),
        );
        const first = await context.objects.AdGroup.adopt(externalId);
        const [second, third] = await Promise.all([
          context.objects.AdGroup.adopt(externalId),
          context.objects.AdGroup.adopt(externalId),
        ]);

        expect(second.id).toBe(first.id);
        expect(third.id).toBe(first.id);

        return { groupId: first.id };
      });
      const receipt = await relate.as(ana).actions.launch(request());

      expect(receipt.state).toBe('succeeded');
      expect(await members()).toHaveLength(1);
      expect(
        (await feed(relate)).filter((entry) => entry.kind === 'adopted'),
      ).toHaveLength(1);
      await relate.close();
    });

    it('re-adopting an existing member keeps its ID and original provenance', async () => {
      const externalId = platform.create('group', 1);
      const relate = app(async ({ objects }) => {
        platform.records.get(externalId)!.budget = 900;
        const { id } = await objects.AdGroup.adopt(externalId);

        return { groupId: id };
      });
      const member = await relate.host.adopt(AdGroup, externalId);
      const receipt = await relate.as(ana).actions.launch(request());

      expect(receipt).toMatchObject({
        state: 'succeeded',
        output: { groupId: member },
      });
      await expect(
        relate.as(ana).objects.AdGroup.get(member),
      ).resolves.toMatchObject({ data: { budget: 900 } });
      expect(
        await relate.host.provenance({
          objectDefinitionId: AdGroup.id,
          objectId: member,
        }),
      ).toEqual({
        kind: 'adopted',
        actor: { kind: 'system', id: 'relate.host' },
        at: expect.any(String),
        sourceDefinitionId: groups.id,
      });

      // Re-adoption is an update of the existing member, attributed to the invocation.
      const entries = (await feed(relate)).filter(
        (entry) => entry.invocationId === receipt.invocationId,
      );

      expect(entries).toEqual([
        expect.objectContaining({
          kind: 'updated',
          changedPropertyIds: ['group.budget'],
          actor: { kind: 'source', id: groups.id },
          triggeredBy: { kind: 'principal', id: 'ana' },
        }),
        expect.objectContaining({ kind: 'invocation-succeeded' }),
      ]);
      await relate.close();
    });

    it('rejects host adoption between two adopt calls and converges on retry without a second create', async () => {
      let race = true;
      let relate!: ReturnType<typeof app>;

      relate = app(async (context) => {
        const output = await createAndAdopt(context);
        const externalId = journal.operations.get(context.idempotencyId)!;

        if (race) {
          race = false;
          await relate.host.adopt(AdGroup, externalId);
        }

        // The overlay never substitutes an ID already handed to the handler.
        await context.objects.AdGroup.adopt(externalId);

        return output;
      });

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'unavailable' });

      const [hosted] = await members();
      const retry = await relate.as(ana).actions.launch(request());

      expect(retry).toMatchObject({
        state: 'succeeded',
        output: { groupId: hosted!.objectId },
      });
      expect(platform.created).toBe(1);
      expect(await members()).toHaveLength(1);
      await relate.close();
    });

    it('aborts when host adoption commits a different ID before acceptance', async () => {
      let relate!: ReturnType<typeof app>;

      relate = app(async (context) => {
        const output = await createAndAdopt(context);

        await relate.host.adopt(
          AdGroup,
          journal.operations.get(context.idempotencyId)!,
        );

        return output;
      });

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'unavailable' });

      const [hosted] = await members();

      expect(await members()).toHaveLength(1);
      expect(
        (await feed(relate)).filter(
          (entry) => entry.kind === 'adopted' && entry.invocationId,
        ),
      ).toEqual([]);
      await expect(relate.as(ana).actions.launch(request())).resolves.toEqual(
        expect.objectContaining({ output: { groupId: hosted!.objectId } }),
      );
      expect(platform.created).toBe(1);
      await relate.close();
    });

    it('isolates the same provider key across object scopes', async () => {
      const externalId = platform.create('group', 1);
      const relate = app(async ({ objects }) => {
        const { id } = await objects.AdGroup.adopt(externalId);

        return { groupId: id };
      });
      const receipt = await relate.as(ana).actions.launch(request());

      if (receipt.state !== 'succeeded') throw new Error('Expected success');

      await expect(
        backing.store.resolve(
          { ...scope(), providerAccountId: 'adv_other' },
          externalId,
        ),
      ).resolves.toBeUndefined();
      await expect(
        backing.store.resolve(scope(), externalId),
      ).resolves.toMatchObject({ objectId: receipt.output.groupId });
      await relate.close();
    });

    it.each([
      ['an unreadable record', 'not-found'],
      ['a deleted record', 'not-found'],
      ['a provider account denial', 'denied'],
      ['a record that fails mapping', 'invalid'],
      ['a not-yet-visible record', 'unavailable'],
      ['a blank source ID', 'invalid'],
    ] as const)('fails adoption of %s as %s', async (situation, code) => {
      const externalId = platform.create(
        'group',
        1,
        situation === 'an unreadable record' ? 'south' : 'north',
        situation !== 'a not-yet-visible record',
      );
      const record = platform.records.get(externalId)!;

      if (situation === 'a deleted record') record.state = 'deleted';

      if (situation === 'a record that fails mapping') record.invalid = true;

      if (situation === 'a provider account denial') platform.deny();

      const relate = app(async ({ objects }) => {
        const { id } = await objects.AdGroup.adopt(
          situation === 'a blank source ID' ? ' ' : externalId,
        );

        return { groupId: id };
      });
      const rejection = await relate
        .as(ana)
        .actions.launch(request())
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(rejection).toMatchObject({ code });
      // A rejection carries no IDs or source values.
      expect(JSON.stringify(rejection)).not.toContain(externalId);
      expect(await members()).toEqual([]);
      await relate.close();
    });

    it('refreshes a pending observation into the overlay once it ages', async () => {
      const relate = app(async (context) => {
        const output = await createAndAdopt(context);

        platform.records.get(
          journal.operations.get(context.idempotencyId)!,
        )!.budget = 700;
        now += 120_000;

        await expect(
          context.objects.AdGroup.get(output.groupId as never),
        ).resolves.toMatchObject({ data: { budget: 700 } });

        return output;
      });
      const receipt = await relate.as(ana).actions.launch(request());

      if (receipt.state !== 'succeeded') throw new Error('Expected success');

      // Committed directly from the overlay, not by an independent refresh.
      const [member] = await members();

      expect(member!.observation.values['group.budget']).toBe(700);
      expect(
        (await feed(relate))
          .filter((entry) => entry.invocationId === receipt.invocationId)
          .map((entry) => entry.kind),
      ).toEqual(['adopted', 'invocation-succeeded']);
      await relate.close();
    });

    it('refreshes stale pending observations during output validation', async () => {
      const relate = app(async (context) => {
        const output = await createAndAdopt(context);

        platform.records.get(
          journal.operations.get(context.idempotencyId)!,
        )!.portfolio = 'south';
        now += 120_000;

        return output;
      });

      // The aged policy evidence is refreshed and no longer authorizes the caller.
      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(await members()).toEqual([]);
      await relate.close();
    });

    it('never authorizes stale values after an explicit refresh observes deletion', async () => {
      const relate = app(async (context) => {
        const output = await createAndAdopt(context);

        platform.records.get(
          journal.operations.get(context.idempotencyId)!,
        )!.state = 'deleted';

        await expect(
          context.objects.AdGroup.get(output.groupId as never, {
            refresh: true,
          }),
        ).resolves.toEqual({ status: 'not-found' });

        return output;
      });

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'not-found' });
      expect(await members()).toEqual([]);
      await relate.close();
    });

    it('merges pending members into queries in Relate-ID order across pages', async () => {
      const committed: string[] = [];
      let seen: string[] = [];
      let restarted: string[] = [];
      let pages = 0;
      const relate = app(async (context) => {
        const ids: string[] = [];
        let page = await context.objects.AdGroup.query({
          limit: 1,
          select: ['id'],
        });

        ids.push(...page.data.map((record) => record.id));

        // Adopt between pages: records at or before the cursor are not revisited.
        const adopted: Awaited<
          ReturnType<typeof context.objects.AdGroup.adopt>
        >['id'][] = [];

        for (const name of ['a', 'b', 'c']) {
          const { id } = await context.objects.AdGroup.adopt(
            platform.create(name, 1),
          );

          adopted.push(id);
        }

        while (!page.meta.exhausted) {
          pages++;
          page = await context.objects.AdGroup.query({
            limit: 1,
            select: ['id'],
            cursor: page.meta.continuationCursor,
          });
          ids.push(...page.data.map((record) => record.id));
        }

        seen = ids;

        for await (const record of context.objects.AdGroup.query({
          limit: 2,
          select: ['id'],
        }))
          restarted.push(record.id);

        return { groupId: adopted[0]! };
      });

      for (let index = 0; index < 4; index++)
        committed.push(
          await relate.host.adopt(AdGroup, platform.create(`c${index}`, 1)),
        );

      const receipt = await relate.as(ana).actions.launch(request());

      if (receipt.state !== 'succeeded') throw new Error('Expected success');

      const all = (await members()).map((object) => object.objectId);

      expect(all).toHaveLength(7);
      // A restarted query enumerates the full membership exactly once, in order.
      expect(restarted).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(
        all.filter((id) => id >= seen[0]! || id === seen[0]),
      );
      expect(pages).toBeGreaterThan(0);
      expect(committed.every((id) => restarted.includes(id))).toBe(true);
      await relate.close();
    });

    it('applies staged values to query predicates', async () => {
      const externalId = platform.create('group', 100);
      let matched: string[] = [];
      const relate = app(async ({ objects }) => {
        platform.records.get(externalId)!.budget = 900;
        const { id } = await objects.AdGroup.adopt(externalId);

        for await (const record of objects.AdGroup.query({
          where: { budget: { gte: 500 } },
          select: ['id'],
        }))
          matched.push(record.id);

        return { groupId: id };
      });
      const member = await relate.host.adopt(AdGroup, externalId);

      await relate.as(ana).actions.launch(request());
      expect(matched).toEqual([member]);
      matched = [];
      await relate.close();
    });

    it('aborts when a newer different observation is committed before acceptance', async () => {
      const externalId = platform.create('group', 1);
      let relate!: ReturnType<typeof app>;

      relate = app(async ({ objects }) => {
        const { id } = await objects.AdGroup.adopt(externalId);

        platform.records.get(externalId)!.budget = 2;
        // An independent consumer refresh commits outside the action.
        await relate.as(ana).objects.AdGroup.get(id, { refresh: true });

        return { groupId: id };
      });
      await relate.host.adopt(AdGroup, externalId);

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(platform.created).toBe(1);
      await relate.close();
    });

    it('commits as unchanged when a newer identical observation was committed', async () => {
      const externalId = platform.create('group', 1);
      let relate!: ReturnType<typeof app>;

      relate = app(async ({ objects }) => {
        const { id } = await objects.AdGroup.adopt(externalId);

        await relate.as(ana).objects.AdGroup.get(id, { refresh: true });

        return { groupId: id };
      });
      const member = await relate.host.adopt(AdGroup, externalId);
      const before = (await members())[0]!.observation.token;
      const receipt = await relate.as(ana).actions.launch(request());

      expect(receipt).toMatchObject({
        state: 'succeeded',
        output: { groupId: member },
      });
      // The committed winner is kept and no source change is recorded.
      expect((await members())[0]!.observation.token).not.toBe(before);
      expect(
        (await feed(relate))
          .filter((entry) => entry.invocationId === receipt.invocationId)
          .map((entry) => entry.kind),
      ).toEqual(['invocation-succeeded']);
      await relate.close();
    });

    it('creates no membership when a host write races a prepared acceptance', async () => {
      if (backing.kind !== 'memory') return;

      const first = platform.create('first', 1);
      const second = platform.create('second', 1);
      let accepted = 0;
      let relate!: ReturnType<typeof app>;

      relate = app(
        async ({ objects }) => {
          const { id } = await objects.AdGroup.adopt(first);

          await objects.AdGroup.adopt(second);
          await objects.Launch.create({ group: id, note: 'x' });

          return { groupId: id };
        },
        {
          transaction: (tx) => ({
            ...tx,
            async accept(scope, input) {
              const result = await tx.accept!(scope, input);

              // A host write after the second preparation resolved, before commit.
              if (++accepted === 2) await relate.host.adopt(AdGroup, second);

              return result;
            },
          }),
        },
      );

      await expect(
        relate.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'unavailable' });

      const objects = await members();

      expect(objects.map((object) => object.sourceRecordId)).toEqual([second]);
      expect(
        (await feed(relate)).filter(
          (entry) => entry.kind === 'created' || entry.invocationId,
        ),
      ).toEqual([]);
      await relate.close();
    });

    it('holds the record lock until commit, so a racing host adoption sees the adopted member', async () => {
      if (backing.kind !== 'postgres') return;

      const externalId = platform.create('group', 1);
      let hosted: Promise<string> | undefined;
      let blocked = false;
      let relate!: ReturnType<typeof app>;

      relate = app(
        async ({ objects }) => {
          const { id } = await objects.AdGroup.adopt(externalId);

          return { groupId: id };
        },
        {
          transaction: (tx) => ({
            ...tx,
            async accept(scope, input) {
              const result = await tx.accept!(scope, input);
              let settled = false;

              hosted = relate.host.adopt(AdGroup, externalId);
              void hosted.then(() => {
                settled = true;
              });
              await new Promise((resolve) => setTimeout(resolve, 100));
              blocked = !settled;

              return result;
            },
          }),
        },
      );

      const receipt = await relate.as(ana).actions.launch(request());

      if (receipt.state !== 'succeeded') throw new Error('Expected success');

      expect(blocked).toBe(true);
      await expect(hosted).resolves.toBe(receipt.output.groupId);
      expect(await members()).toHaveLength(1);
      // Exactly one adoption entry, published with the action's batch.
      expect(
        (await feed(relate)).filter((entry) => entry.kind === 'adopted'),
      ).toEqual([
        expect.objectContaining({ invocationId: receipt.invocationId }),
      ]);
      await relate.close();
    });

    it('recovers a lost external-create response without creating a second record', async () => {
      // Provider state outlives the action and the integration's journal write.
      const external = new Map<string, string>();
      const recovered = new Map<string, string>();
      let calls = 0;
      const relate = app(async ({ input, idempotencyId, objects }) => {
        calls++;
        let externalId = recovered.get(idempotencyId);

        if (!externalId) {
          externalId = external.get(idempotencyId);

          if (!externalId) {
            external.set(
              idempotencyId,
              platform.create(input.name, input.budget),
            );
            throw new Error(
              'Provider committed but the create response was lost',
            );
          }

          recovered.set(idempotencyId, externalId);
        }

        const { id } = await objects.AdGroup.adopt(externalId);

        return { groupId: id };
      });

      try {
        await expect(
          relate.as(ana).actions.launch(request()),
        ).rejects.toMatchObject({ code: 'internal' });
        expect(await members()).toEqual([]);
        expect(platform.created).toBe(1);
        expect(recovered.size).toBe(0);

        const receipt = await relate.as(ana).actions.launch(request());

        expect(receipt.state).toBe('succeeded');
        expect(await relate.as(ana).actions.launch(request())).toEqual(receipt);
        expect(calls).toBe(2);
        expect(platform.created).toBe(1);
        expect(recovered.size).toBe(1);
        expect(await members()).toHaveLength(1);
      } finally {
        await relate.close();
      }
    });

    it('rechecks an expired adoption that is neither returned nor referenced', async () => {
      const Adopt = defineAction({
        id: 'adopt-only',
        input: z.object({}),
        output: z.object({}),
        adopts: [AdGroup],
        policy: { execute: access.role('employee') },
      });
      const graph = defineGraph({
        id: 'unreferenced-adoption',
        objects: { AdGroup },
        actions: { adopt: Adopt },
        access,
        policies: { AdGroup: policy },
      });
      const externalId = platform.create('group', 1);
      const relate = createRuntime({
        graph,
        graphId,
        store: backing.store,
        clock: () => now,
        bindings: [
          bind(groups, {
            providerAccountId: 'adv_42',
            connectionId: 'tiktok',
            resourceId: 'ad-groups',
            connector: platform.connector,
          }),
        ],
        actionImplementations: [
          implementAction(graph, Adopt, async ({ objects }) => {
            await objects.AdGroup.adopt(externalId);
            platform.records.get(externalId)!.portfolio = 'south';
            now += 30_001;

            return {};
          }),
        ],
      });

      try {
        await expect(
          relate.as(ana).actions.adopt({ input: {}, idempotencyKey: 'key' }),
        ).rejects.toMatchObject({ code: 'not-found' });
        expect(
          await backing.store.scan(
            {
              ...scope(),
              definitionRevision: compile(graph).definitionRevision,
            },
            { limit: 10 },
          ),
        ).toEqual({ objects: [], hasMore: false });
      } finally {
        await relate.close();
      }
    });

    for (const dependency of ['adopted-object', 'native-policy'] as const) {
      for (const elapsed of [10, 11, -1]) {
        it(`checks ${dependency} evidence locally after later validation advances the clock by ${elapsed}ms`, async () => {
          const checks = defineSource({
            id: 'checks',
            idField: 'id',
            schema: z.object({ id: z.string() }),
          });
          const Check = defineObject({
            id: 'check',
            membership: source(checks),
            properties: { id: objectId({ id: 'check.id' }) },
          });
          const Adopt = defineAction({
            id: 'adopt-check',
            input: z.object({}),
            output: z.object({}),
            adopts: [AdGroup, Check],
            creates: [Launch],
            policy: { execute: access.role('employee') },
          });
          const graph = defineGraph({
            id: 'adoption-validation',
            objects: { AdGroup, Check, Launch },
            actions: { adopt: Adopt },
            access,
            policies: {
              AdGroup: {
                read: {
                  ...policy.read,
                  evidenceMaxAgeMs:
                    dependency === 'adopted-object' ? 10 : 30_000,
                },
              },
              Check: { read: { gate: access.role('employee') } },
              Launch: {
                read: {
                  ...adoptionGraph.policies.Launch.read,
                  evidenceMaxAgeMs: 10,
                },
                create: {
                  ...adoptionGraph.policies.Launch.create,
                  evidenceMaxAgeMs: 10,
                },
              },
            },
          });
          const initialTime = now;
          let handlerDone = false;
          let existingId = '' as ObjectId<typeof AdGroup.id>;
          const externalId = platform.create('group', 1);
          const relate = createRuntime({
            graph,
            graphId,
            store: backing.store,
            clock: () => now,
            bindings: [
              bind(groups, {
                providerAccountId: 'adv_42',
                connectionId: 'tiktok',
                resourceId: 'ad-groups',
                connector: platform.connector,
              }),
              bind(checks, {
                providerAccountId: 'checks',
                connectionId: 'checks',
                resourceId: 'checks',
                connector: {
                  identify: async () => {
                    if (handlerDone) now = initialTime + elapsed;

                    return 'checks';
                  },
                  fetch: async (id) => ({
                    providerAccountId: 'checks',
                    state: 'present' as const,
                    record: { id },
                  }),
                },
              }),
            ],
            actionImplementations: [
              implementAction(graph, Adopt, async ({ objects }) => {
                if (dependency === 'adopted-object')
                  await objects.AdGroup.adopt(externalId);
                else
                  await objects.Launch.create({
                    group: existingId,
                    note: 'Native policy uses an existing source member',
                  });

                await objects.Check.adopt('last');
                handlerDone = true;

                return {};
              }),
            ],
          });
          const revision = compile(graph).definitionRevision;
          const checkScope: StorageScope = {
            graphId,
            definitionRevision: revision,
            objectDefinitionId: Check.id,
            sourceDefinitionId: checks.id,
            connectionId: 'checks',
            resourceId: 'checks',
            providerAccountId: 'checks',
            partition: 'shared-service',
          };

          try {
            if (dependency === 'native-policy')
              existingId = await relate.host.adopt(AdGroup, externalId);

            const invoke = relate
              .as(ana)
              .actions.adopt({ input: {}, idempotencyKey: 'key' });

            if (elapsed === 10)
              await expect(invoke).resolves.toMatchObject({
                state: 'succeeded',
              });
            else
              await expect(invoke).rejects.toMatchObject({
                code: 'unavailable',
              });

            expect(
              (await backing.store.scan(checkScope, { limit: 10 })).objects,
            ).toHaveLength(elapsed === 10 ? 1 : 0);
            expect(
              (
                await backing.store.native!.scan(
                  { graphId, definitionRevision: revision },
                  Launch.id,
                  { limit: 10 },
                )
              ).objects,
            ).toHaveLength(
              elapsed === 10 && dependency === 'native-policy' ? 1 : 0,
            );
            const entries = (
              await relate.host.activity.feed.read({ limit: 100 })
            ).entries;

            expect(entries.filter((entry) => entry.invocationId)).toHaveLength(
              elapsed === 10 ? 3 : 0,
            );
          } finally {
            await relate.close();
          }
        });
      }
    }

    it('rejects startup for adopting graphs without the store capability', async () => {
      const store = backing.store;
      const { capabilities: _, ...native } = store.native!;
      const unsupported = { ...store, native };

      expect(() => app(createAndAdopt, { store: unsupported })).toThrow(
        'Store does not support action adoption',
      );

      // An advertising store whose transaction lacks accept fails before the handler.
      let calls = 0;
      const inconsistent = app(
        async (context) => {
          calls++;

          return createAndAdopt(context);
        },
        {
          transaction: (tx) => {
            const { accept: _, ...rest } = tx;

            return rest;
          },
        },
      );

      await expect(
        inconsistent.as(ana).actions.launch(request()),
      ).rejects.toMatchObject({ code: 'internal' });
      expect(calls).toBe(0);
      expect(platform.created).toBe(0);
      await inconsistent.close();
    });

    it('describes adopted types in discovery', async () => {
      const relate = app(createAndAdopt);
      const discovery = relate.operations(ana).discovery;

      expect(discovery.describe().actions).toMatchObject({
        launch: { creates: ['Launch'], adopts: ['AdGroup'] },
        rename: { creates: [], adopts: [] },
      });
      expect(
        discovery
          .describeAction(LaunchAdGroup.id)
          ?.adopts.map((object) => object.apiName),
      ).toEqual(['AdGroup']);
      await relate.close();
    });

    it('records adoption feed entries that pass validation and precede the receipt event', async () => {
      const relate = app(createAndAdopt);
      const receipt = await relate.as(ana).actions.launch(request());
      const entries: readonly FeedEntry[] = await feed(relate);
      const position = (kind: string) =>
        entries.findIndex(
          (entry) =>
            entry.kind === kind && entry.invocationId === receipt.invocationId,
        );

      expect(position('adopted')).toBeGreaterThanOrEqual(0);
      expect(position('adopted')).toBeLessThan(
        position('invocation-succeeded'),
      );
      await relate.close();
    });
  });
}
