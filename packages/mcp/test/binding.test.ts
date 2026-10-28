import { expect, it, onTestFinished, vi } from 'vitest';
import type { GraphBinding } from '@relate/mcp';
import { createDevelopmentExecutor, createMcpServer } from '@relate/mcp';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describeBinding, snapshotBinding } from '../src/binding.js';
import { createFixture } from './fixture.js';

it('projects missing details, absent routes, traversals and created types consistently across discovery and execution', async () => {
  const { binding } = await createFixture(onTestFinished);
  const discovery = binding.operations.discovery;
  const overview = discovery.describe();
  const note = discovery.describeObject('test.note')!;
  const action = discovery.describeAction('test.add-note')!;
  const graph: GraphBinding = {
    description: {
      ...binding.description,
      objects: {
        Note: {
          definitionId: 'test.note',
          traversals: { hidden: { target: 'Hidden', cardinality: 'many' } },
        },
        Hidden: { definitionId: 'hidden', traversals: {} },
      },
      actions: {
        ...binding.description.actions,
        hiddenAction: { definitionId: 'hidden-action' },
      },
    },
    operations: {
      ...binding.operations,
      discovery: {
        describe: () => ({
          ...overview,
          objects: {
            Note: {
              traversals: { hidden: { target: 'Hidden', cardinality: 'many' } },
            },
            Hidden: { traversals: {} },
            NoRoute: { traversals: {} },
          },
          actions: {
            addNote: {
              creates: ['Note', 'Hidden'],
              adopts: ['Note', 'Hidden'],
            },
            hiddenAction: { creates: [], adopts: [] },
            noRoute: { creates: [], adopts: [] },
          },
        }),
        describeObject: (id) =>
          id === 'test.note'
            ? {
                ...note,
                traversals: [
                  {
                    name: 'hidden',
                    relationshipDefinitionId: 'hidden-edge',
                    cardinality: 'many',
                    returns: 'Page',
                    target: {
                      ...note,
                      apiName: 'Hidden',
                      definitionId: 'hidden',
                    },
                  },
                ],
              }
            : undefined,
        describeAction: (id) =>
          id === 'test.add-note'
            ? {
                ...action,
                creates: [
                  note,
                  { ...note, apiName: 'Hidden', definitionId: 'hidden' },
                ],
                adopts: [
                  note,
                  { ...note, apiName: 'Hidden', definitionId: 'hidden' },
                ],
              }
            : undefined,
      },
    },
  };
  const server = createMcpServer({
    executor: createDevelopmentExecutor(),
    bindGraph: () => graph,
  });
  const client = new Client({ name: 'projection-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();

  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(b);
  await client.connect(a);
  const discovered = await client.callTool({ name: 'discover', arguments: {} });
  const executed = await client.callTool({
    name: 'execute',
    arguments: {
      code: `return {
    overview: graph.describe(), objects: Object.keys(graph.objects), actions: Object.keys(graph.actions),
    edges: Object.keys(graph.objects.Note.traverse), detailEdges: graph.objects.Note.describe().traversals,
    creates: graph.actions.addNote.describe().creates.map(object => object.apiName),
    adopts: graph.actions.addNote.describe().adopts.map(object => object.apiName)
  };`,
    },
  });
  const expected = {
    ...overview,
    objects: { Note: { traversals: {} } },
    actions: { addNote: { creates: ['Note'], adopts: ['Note'] } },
  };

  expect(discovered.structuredContent).toMatchObject({ graph: expected });
  expect(executed.structuredContent).toMatchObject({
    status: 'succeeded',
    result: {
      overview: expected,
      objects: ['Note'],
      actions: ['addNote'],
      edges: [],
      detailEdges: [],
      creates: ['Note'],
      adopts: ['Note'],
    },
  });
});

it('does not deep-clone discovery details; execution still captures its own snapshot', async () => {
  const { binding } = await createFixture(onTestFinished);
  const clone = vi.spyOn(globalThis, 'structuredClone');

  onTestFinished(() => clone.mockRestore());
  const describe = vi.fn(binding.operations.discovery.describe);
  const graph = {
    ...binding,
    operations: {
      ...binding.operations,
      discovery: { ...binding.operations.discovery, describe },
    },
  };
  const overview = describeBinding(graph);

  expect(clone).not.toHaveBeenCalled();
  expect(describe).toHaveBeenCalledTimes(1);
  const snapshot = snapshotBinding(graph);

  expect(clone).toHaveBeenCalledTimes(1);
  expect(snapshot.overview).toEqual(overview);
  expect(snapshot.overview).not.toBe(overview);
});
