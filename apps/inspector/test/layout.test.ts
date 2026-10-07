import { expect, it } from 'vitest';
import ElkModule from 'elkjs/lib/elk.bundled.js';
import { layoutWithElk, toElkGraph } from '../src/layout/elk.js';
import type { ElkLike, LayoutRequest } from '../src/layout/elk.js';

// elkjs ships CommonJS with ESM-style typings; Node hands the class back directly.
type ElkConstructor = new () => ElkLike;

const ELK =
  (ElkModule as unknown as { default?: ElkConstructor }).default ??
  (ElkModule as unknown as ElkConstructor);

const request: LayoutRequest = {
  generation: 7,
  nodes: [
    { id: 'business.invoice', width: 272, height: 140 },
    { id: 'business.customer', width: 272, height: 160 },
    { id: 'business.account-review', width: 272, height: 140 },
  ],
  edges: [
    {
      id: 'business.customer-reviews',
      source: 'business.customer',
      target: 'business.account-review',
    },
    {
      id: 'business.customer-invoices',
      source: 'business.customer',
      target: 'business.invoice',
    },
    { id: 'dangling', source: 'business.customer', target: 'missing' },
  ],
};

it('builds a deterministic ELK graph sorted by stable IDs with dangling edges dropped', () => {
  const elkGraph = toElkGraph(request);

  expect(elkGraph.children?.map((child) => child.id)).toEqual([
    'business.account-review',
    'business.customer',
    'business.invoice',
  ]);
  expect(elkGraph.edges?.map((edge) => edge.id)).toEqual([
    'business.customer-invoices',
    'business.customer-reviews',
  ]);
  expect(elkGraph.layoutOptions).toMatchObject({
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.randomSeed': '42',
  });
});

it('lays out left to right with the same positions for the same input', async () => {
  const elk = new ELK();
  const first = await layoutWithElk(request, elk);
  const second = await layoutWithElk(
    { ...request, nodes: [...request.nodes].reverse() },
    elk,
  );

  expect(first.generation).toBe(7);
  expect(Object.keys(first.positions).sort()).toEqual(
    request.nodes.map((node) => node.id).sort(),
  );
  expect(second.positions).toEqual(first.positions);
  const customer = first.positions['business.customer']!;

  for (const id of ['business.invoice', 'business.account-review'])
    expect(first.positions[id]!.x).toBeGreaterThan(customer.x);

  expect(
    await layoutWithElk({ generation: 1, nodes: [], edges: [] }, elk),
  ).toEqual({ generation: 1, positions: {} });
});

it('fails loudly when ELK omits a position', async () => {
  await expect(
    layoutWithElk(request, {
      layout: async (graph) => ({ ...graph, children: [] }),
    }),
  ).rejects.toThrow(/no position/);
});
