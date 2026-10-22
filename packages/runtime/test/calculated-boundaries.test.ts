import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { compile } from 'relate/compiler';
import {
  computed,
  defineAccess,
  defineAction,
  defineDataset,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  nativeMembership,
  reference,
  source,
} from 'relate';
import { createRuntime, createMemoryStore } from '@relate/runtime';
import type { ActionExecutionContext } from '@relate/runtime';
import { calculatedReadIssues } from '../src/reads/index.js';

function setup(
  read: (context: ActionExecutionContext, childId?: string) => Promise<unknown>,
  restricted = false,
) {
  const access = defineAccess({
    roles: ['reader', 'sensitive'],
    fieldGroups: ['ordinary', 'sensitive'],
    claims: {},
  });
  const parents = defineSource({
    id: 'parents',
    idField: 'id',
    schema: z.object({ id: z.string() }),
  });
  const children = defineSource({
    id: 'children',
    idField: 'id',
    schema: z.object({
      id: z.string(),
      parentId: z.string(),
      label: z.string(),
    }),
  });
  const Events = defineDataset({
    id: 'events',
    columns: {
      childId: {
        id: 'events.child',
        schema: z.string(),
        access: access.groups.ordinary,
      },
    },
  });
  const Parent = defineObject({
    id: 'parent',
    membership: source(parents),
    properties: { id: objectId({ id: 'parent.id' }) },
  });
  const Child = defineObject({
    id: 'child',
    membership: source(children),
    properties: {
      id: objectId({ id: 'child.id' }),
      parent: reference(Parent, {
        id: 'child.parent',
        from: children.fields.parentId,
      }),
      label: from(children.fields.label, { id: 'child.label' }),
      total: computed({
        id: 'child.total',
        sql: 'SELECT COUNT(*) FROM self.events',
        access: restricted ? access.groups.sensitive : access.groups.ordinary,
      }),
    },
    datasets: {
      events: {
        id: 'child.events',
        dataset: Events,
        on: [{ column: 'childId', property: 'id' }],
      },
    },
  });
  const relation = defineRelationship({
    id: 'relation',
    via: Child.properties.parent,
    forward: 'children',
    reverse: 'parent',
  });
  const Probe = defineAction({
    id: 'probe',
    input: z.object({}),
    output: z.object({}),
    creates: [],
    policy: { execute: access.role('reader') },
  });
  const graph = defineGraph({
    id: 'graph',
    objects: { Parent, Child },
    datasets: { Events },
    relationships: { relation },
    actions: { Probe },
    access,
    policies: {
      Events: {},
      Parent: { read: { gate: access.role('reader') } },
      Child: {
        read: { gate: access.role('reader') },
        groups: { sensitive: access.role('sensitive') },
        datasets: { events: { gate: access.role('reader') } },
      },
    },
  });
  const fetch = vi.fn(async (id: string) => ({
    state: 'present' as const,
    record: { id, parentId: 'p', label: 'ordinary' },
  }));
  let childId: string | undefined;
  const runtime = createRuntime({
    model: compile(graph),
    graphId: 'guards',
    sources: Object.fromEntries(
      [parents, children].map((definition) => [
        definition.id,
        {
          connectionId: 'crm',
          resourceId: definition.id,
          authorization: 'shared-service' as const,
          connector: { identity: 'application' as const, fetch },
        },
      ]),
    ),
    actionHandlers: {
      [Probe.id]: async (context) => {
        await read(context, childId);

        return {};
      },
    },
  });
  const actor = { id: 'reader', roles: ['reader'], claims: {} };

  return {
    runtime,
    fetch,
    actor,
    async adopt() {
      const parentId = await runtime.adopt(Parent.id, 'p');

      childId = await runtime.adopt(Child.id, 'c');
      fetch.mockClear();

      return { parentId, childId };
    },
  };
}

it.each([
  ['explicit selection', { select: ['label', 'total'] }],
  ['filter', { select: ['label'], where: { total: { gt: '1' } } }],
  [
    'order',
    { select: ['label'], orderBy: [{ field: 'total', direction: 'desc' }] },
  ],
] as const)(
  'rejects traversal %s before source reads, including an empty population',
  async (_label, request) => {
    const { runtime, fetch, actor } = setup(async () => undefined);

    try {
      await expect(
        runtime.traverse(
          actor,
          'parent',
          'unknown',
          'children',
          request as never,
        ),
      ).rejects.toMatchObject({
        code: 'invalid-request',
        issues: expect.arrayContaining([
          expect.objectContaining({ problem: 'not-supported' }),
        ]),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await runtime.drainActivity(1000);
    }
  },
);

it.each([undefined, ['label'] as const])(
  'keeps ordinary traversal fields available with selection %s',
  async (select) => {
    const { runtime, fetch, actor, adopt } = setup(async () => undefined);

    try {
      const { parentId } = await adopt();
      const result = await runtime.traverse(
        actor,
        'parent',
        parentId,
        'children',
        select ? { select } : {},
      );

      expect(result).toMatchObject({ data: [{ data: { label: 'ordinary' } }] });
      expect(JSON.stringify(result)).not.toContain('child.total');
    } finally {
      await runtime.drainActivity(1000);
    }
  },
);

it('does not include unreadable calculated fields in default selection', async () => {
  const { runtime, actor, adopt } = setup(async () => undefined, true);

  try {
    const { parentId } = await adopt();
    const result = await runtime.traverse(
      actor,
      'parent',
      parentId,
      'children',
      {},
    );

    expect(result).toMatchObject({ data: [{ data: { label: 'ordinary' } }] });
  } finally {
    await runtime.drainActivity(1000);
  }
});

it.each([
  [
    'get default',
    (context: ActionExecutionContext) => context.read('child', 'unknown'),
  ],
  [
    'get explicit',
    (context: ActionExecutionContext) =>
      context.read('child', 'unknown', { select: ['total'] }),
  ],
  [
    'query default',
    (context: ActionExecutionContext) => context.query('child'),
  ],
  [
    'query filter',
    (context: ActionExecutionContext) =>
      context.query('child', {
        select: ['label'],
        where: { total: { gt: '1' } },
      }),
  ],
  [
    'query order',
    (context: ActionExecutionContext) =>
      context.query('child', {
        select: ['label'],
        orderBy: [{ field: 'total', direction: 'asc' }],
      } as never),
  ],
] as const)(
  'rejects transaction-bound %s before source reads',
  async (_label, read) => {
    let observed: unknown;
    const { runtime, fetch, actor } = setup(async (context) => {
      try {
        return await read(context);
      } catch (error) {
        observed = error;
        throw error;
      }
    });

    try {
      await expect(
        runtime.invoke(actor, 'probe', { input: {}, idempotencyKey: 'key' }),
      ).rejects.toBeDefined();
      expect(observed).toMatchObject({
        code: 'invalid-request',
        issues: expect.arrayContaining([
          expect.objectContaining({ problem: 'not-supported' }),
        ]),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await runtime.drainActivity(1000);
    }
  },
);

it('retains ordinary get and query inside an action transaction', async () => {
  let observed: unknown[] = [];
  const { runtime, actor, adopt } = setup(async (context, id) => {
    observed = [
      await context.read('child', id!, { select: ['label'] }),
      await context.query('child', { select: ['label'] }),
    ];
  });

  try {
    await adopt();
    await runtime.invoke(actor, 'probe', { input: {}, idempotencyKey: 'key' });
    expect(observed[0]).toMatchObject({
      status: 'ok',
      data: { label: 'ordinary' },
    });
    expect(observed[1]).toMatchObject({
      data: [{ data: { label: 'ordinary' } }],
    });
  } finally {
    await runtime.drainActivity(1000);
  }
});

it('leaves malformed options for the ordinary request validator', () => {
  const properties = [{ name: 'total', defaultSelected: true }];

  expect(calculatedReadIssues(null, properties)).toEqual([]);
  expect(calculatedReadIssues([], properties)).toEqual([]);
  expect(calculatedReadIssues({ select: 42 }, properties)).toEqual([]);
  expect(calculatedReadIssues({ select: ['label'] }, properties)).toEqual([]);
  expect(
    calculatedReadIssues({}, [{ name: 'total', defaultSelected: false }]),
  ).toEqual([]);
});

it('never accepts calculated values in native writes or stores them on a created object', async () => {
  const access = defineAccess({
    roles: ['reader'],
    fieldGroups: ['ordinary'],
    claims: {},
  });
  const Item = defineObject({
    id: 'item',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'item.id' }),
      total: computed({
        id: 'item.total',
        sql: 'SELECT COUNT(*) FROM self.events',
      }),
    },
  });
  const Add = defineAction({
    id: 'add',
    input: z.object({ inject: z.boolean() }),
    output: z.object({ id: z.string() }),
    creates: [Item],
    policy: { execute: access.role('reader') },
  });
  const graph = defineGraph({
    id: 'native',
    objects: { Item },
    actions: { Add },
    access,
    policies: {
      Item: {
        read: { gate: access.role('reader') },
        create: { gate: access.role('reader') },
      },
    },
  });
  const model = compile(graph);
  const store = createMemoryStore();
  const runtime = createRuntime({
    model,
    graphId: 'native',
    store,
    sources: {},
    actionHandlers: {
      add: async (context) =>
        context.create('item', context.input.inject ? { total: '1' } : {}),
    },
  });
  const actor = { id: 'reader', roles: ['reader'], claims: {} };

  try {
    await expect(
      runtime.invoke(actor, 'add', {
        input: { inject: true },
        idempotencyKey: 'bad',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(
      await runtime.query(actor, 'item', { select: ['id'] }),
    ).toMatchObject({ data: [] });
    const receipt = await runtime.invoke(actor, 'add', {
      input: { inject: false },
      idempotencyKey: 'good',
    });

    expect(receipt.state).toBe('succeeded');

    if (receipt.state !== 'succeeded') throw new Error('Expected creation');

    const record = await store.native!.load(
      { graphId: 'native', definitionRevision: model.definitionRevision },
      'item',
      z.object({ id: z.string() }).parse(receipt.output).id,
    );

    expect(record?.values).toEqual({});
  } finally {
    await runtime.drainActivity(1000);
  }
});
