import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ObservationStore,
  FeedDraft,
  OperationDraft,
  StorageScope,
} from 'relate/storage';
import { activityId, NativeCommitUncertain } from '@relate/runtime/storage';

export function feedDraft(
  graphId: string,
  kind: 'created' | 'invocation-succeeded' = 'created',
): FeedDraft {
  const common = {
    schemaVersion: 1 as const,
    id: activityId(),
    graphId,
    definitionRevision: 'v1',
    operationId: activityId(),
    invocationId: randomUUID(),
    actor: { kind: 'principal' as const, id: 'ana' },
    context: { requestId: 'request', transport: 'embedded' as const },
    occurredAt: new Date().toISOString(),
  };

  return kind === 'created'
    ? {
        ...common,
        kind,
        object: { objectDefinitionId: 'review', objectId: randomUUID() },
        changedPropertyIds: ['review.note'],
      }
    : { ...common, kind, actionDefinitionId: 'add-review' };
}

export function operationDraft(graphId: string): OperationDraft {
  return {
    schemaVersion: 1,
    id: activityId(),
    graphId,
    definitionRevision: 'v1',
    kind: 'get',
    actor: { kind: 'principal', id: 'ana' },
    context: { requestId: 'request', transport: 'embedded' },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 1,
    definitionId: 'customer',
    target: { objectDefinitionId: 'customer', objectId: '1' },
    outcome: { status: 'ok' },
    details: {},
    objects: [
      {
        objectDefinitionId: 'customer',
        objectId: '1',
        role: 'target',
        returned: [],
        forbidden: [],
        unavailable: [],
      },
      {
        objectDefinitionId: 'customer',
        objectId: '1',
        role: 'returned',
        returned: ['customer.name'],
        forbidden: ['customer.revenue'],
        unavailable: [],
      },
    ],
  };
}

export function activityStoreContract(
  name: string,
  open: () => Promise<{ store: ObservationStore; close(): Promise<void> }>,
) {
  describe(name, () => {
    async function setup() {
      const backing = await open(),
        graphId = randomUUID();

      await backing.store.install(graphId, 'v1');

      return {
        ...backing,
        graphId,
        scope: { graphId, definitionRevision: 'v1' },
      };
    }

    it('publishes mixed entries atomically, resumes filters, and binds cursors', async () => {
      const { store, graphId, scope, close } = await setup();

      try {
        const drafts = [
          feedDraft(graphId),
          feedDraft(graphId, 'invocation-succeeded'),
          feedDraft(graphId),
        ];

        await store.native!.transaction(scope, async (tx) => {
          await tx.appendFeed!(drafts);
        });
        const first = await store.activity!.feed.read(graphId, { limit: 1 });

        expect(first.entries.map((r) => r.id)).toEqual([drafts[0]!.id]);
        expect(first.hasMore).toBe(true);
        const next = await store.activity!.feed.read(graphId, {
          cursor: first.nextCursor,
          limit: 2,
        });

        expect(next.entries.map((r) => r.kind)).toEqual([
          'invocation-succeeded',
          'created',
        ]);
        const empty = await store.activity!.feed.read(graphId, {
          filter: { actor: { kind: 'principal', id: 'nobody' } },
        });

        expect(empty.entries).toEqual([]);
        expect(
          (
            await store.activity!.feed.read(graphId, {
              cursor: empty.nextCursor,
            })
          ).entries,
        ).toEqual([]);
        await expect(
          store.activity!.feed.read(graphId, {
            cursor: first.nextCursor,
            filter: {},
          } as never),
        ).rejects.toMatchObject({ code: 'invalid-request' });
        await expect(
          store.activity!.operations.list(graphId, {
            cursor: first.nextCursor,
          }),
        ).rejects.toMatchObject({ code: 'invalid-cursor' });
        await store.install('other-' + graphId, 'v1');
        await expect(
          store.activity!.feed.read('other-' + graphId, {
            cursor: first.nextCursor,
          }),
        ).rejects.toMatchObject({ code: 'invalid-cursor' });
        const filtered = await store.activity!.feed.read(graphId, {
          filter: { actionDefinitionId: 'add-review' },
        });

        expect(filtered.entries.map((r) => r.id)).toEqual([drafts[1]!.id]);
      } finally {
        await close();
      }
    });
    it('rolls back feed drafts with savepoints and outer transactions and revokes handles', async () => {
      const { store, graphId, scope, close } = await setup();

      try {
        let retained:
          | Parameters<
              Parameters<
                NonNullable<ObservationStore['native']>['transaction']
              >[1]
            >[0]
          | undefined;

        await expect(
          store.native!.transaction(scope, async (tx) => {
            retained = tx;
            await tx.appendFeed!([feedDraft(graphId)]);
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        await expect(
          retained!.appendFeed!([feedDraft(graphId)]),
        ).rejects.toThrow();
        await store.native!.transaction(scope, async (tx) => {
          await expect(
            tx.savepoint(async () => {
              await tx.appendFeed!([feedDraft(graphId)]);
              throw new Error('savepoint');
            }),
          ).rejects.toThrow('savepoint');
          await tx.appendFeed!([feedDraft(graphId, 'invocation-succeeded')]);
        });
        expect(
          (await store.activity!.feed.read(graphId)).entries.map((r) => r.kind),
        ).toEqual(['invocation-succeeded']);
      } finally {
        await close();
      }
    });
    it('keeps operation appends first-write-wins including ordered lineage and conflicting duplicates', async () => {
      const { store, graphId, close } = await setup();

      try {
        const draft = operationDraft(graphId),
          other = { ...draft, objects: [] };

        await store.activity!.appendOperations(graphId, [draft, other]);
        await store.activity!.appendOperations(graphId, [other]);
        const page = await store.activity!.operations.list(graphId);

        expect(page.entries).toHaveLength(1);
        expect(page.entries[0]!.objects).toEqual(draft.objects);
        expect(
          (
            await store.activity!.operations.list(graphId, {
              filter: {
                object: { objectDefinitionId: 'customer', objectId: '1' },
                objectRole: 'returned',
              },
            })
          ).entries,
        ).toHaveLength(1);
        await expect(
          store.activity!.appendOperations(graphId, [
            {
              ...draft,
              id: activityId(),
              details: { refresh: 'changed' },
            } as never,
          ]),
        ).rejects.toThrow();
        await expect(
          store.activity!.appendOperations(graphId, [
            {
              ...draft,
              id: activityId(),
              kind: 'invoke',
              replayed: true,
              invocationId: undefined,
            } as never,
          ]),
        ).rejects.toThrow();
      } finally {
        await close();
      }
    });
    it('classifies accepted source transitions and retains adoption independently', async () => {
      const { store, graphId, close } = await setup();
      const scope: StorageScope = {
        graphId,
        definitionRevision: 'v1',
        objectDefinitionId: 'customer',
        sourceDefinitionId: 'crm',
        connectionId: 'connection',
        providerAccountId: null,
        partition: 'shared-service',
      };
      const provenance = () => ({
        actor: { kind: 'principal' as const, id: 'ana' },
        operationId: activityId(),
        parentOperationId: activityId(),
        context: { requestId: 'r', transport: 'embedded' as const },
        occurredAt: new Date().toISOString(),
        changeId: activityId(),
      });

      try {
        const accept = async (
          state: 'present' | 'deleted',
          values: Record<string, string>,
          raw: Record<string, string> = {},
        ) =>
          store.accept(scope, {
            sourceRecordId: 'source',
            adopt: true,
            observation: {
              state,
              values,
              raw,
              observedAt: Date.now(),
              token: await store.beginFetch(),
            },
            provenance: provenance(),
          });
        const first = await accept('present', {
          'customer.name': 'one',
          'customer.removed': 'old',
        });

        await accept(
          'present',
          { 'customer.name': 'one', 'customer.removed': 'old' },
          { raw: 'different' },
        );
        await accept('present', { 'customer.name': 'two' });
        await accept('deleted', {});
        await accept('present', { 'customer.name': 'three' });
        const feed = await store.activity!.feed.read(graphId, {
          filter: { sourceDefinitionId: 'crm' },
        });

        expect(feed.entries.map((r) => r.kind)).toEqual([
          'adopted',
          'updated',
          'deleted',
          'restored',
        ]);
        expect(feed.entries[1]).toMatchObject({
          changedPropertyIds: ['customer.name', 'customer.removed'],
          actor: { kind: 'source', id: 'crm' },
          triggeredBy: { kind: 'principal', id: 'ana' },
        });
        expect(feed.entries.every((r) => !r.invocationId)).toBe(true);
        expect(
          await store.provenance(scope, first.object.objectId),
        ).toMatchObject({
          kind: 'adopted',
          actor: { kind: 'principal', id: 'ana' },
          sourceDefinitionId: 'crm',
        });
        expect(
          (
            await store.activity!.feed.read(graphId, {
              filter: { actor: { kind: 'principal', id: 'ana' } },
            })
          ).entries.map((r) => r.kind),
        ).toEqual(['adopted']);
      } finally {
        await close();
      }
    });
    it('rejects malformed feed batches before changing native state', async () => {
      const { store, graphId, scope, close } = await setup();

      try {
        await expect(
          store.native!.transaction(scope, async (tx) => {
            await tx.insert({
              objectDefinitionId: 'review',
              objectId: 'new',
              values: {},
              createdAt: Date.now(),
            });
            await tx.appendFeed!([
              { ...feedDraft(graphId), kind: 'invocation-failed' } as never,
            ]);
          }),
        ).rejects.toThrow();
        expect(
          await store.native!.load(scope, 'review', 'new'),
        ).toBeUndefined();
        expect((await store.activity!.feed.read(graphId)).entries).toEqual([]);
      } finally {
        await close();
      }
    });
  });
}
