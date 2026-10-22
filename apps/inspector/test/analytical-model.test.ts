import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { createAnalyticalGraph } from '../../../tests/support/analytical-graph.js';
import {
  describeDatasetType,
  dockDatasets,
  highlightable,
  layoutSignature,
  mapManifest,
} from '../src/graph/map.js';
import { SidePanel } from '../src/panel/SidePanel.js';
import { initialState } from '../src/connection/store.js';

it('maps compiled datasets, column groups, associations and computed declarations without SQL', () => {
  const { graph } = createAnalyticalGraph();
  const { manifest } = compile(graph);
  const model = mapManifest(manifest);

  expect(model.nodes.map((node) => [node.id, node.data.kind])).toEqual([
    ['customer', 'object'],
    ['events', 'dataset'],
  ]);
  expect(model.nodes[1]!.data).toMatchObject({
    apiName: 'Events',
    columns: expect.arrayContaining([
      {
        id: 'events.amount',
        name: 'amount',
        type: 'int64',
        access: 'ordinary',
      },
      {
        id: 'events.secret',
        name: 'secret',
        type: 'string',
        access: 'private',
        role: 'private',
      },
    ]),
  });
  expect(model.nodes[0]!.data).toMatchObject({
    calculations: [{ id: 'customer.count', name: 'count', access: 'private' }],
  });
  expect(model.edges).toEqual([
    {
      id: 'customer.events',
      source: 'customer',
      target: 'events',
      data: {
        kind: 'association',
        id: 'customer.events',
        name: 'events',
        role: 'analyst',
        on: [{ column: 'customerId', property: 'externalId' }],
      },
    },
  ]);
  expect(JSON.stringify(model)).not.toContain('SELECT');
  expect([
    ...highlightable(model, ['events', 'customer.events']).nodes,
  ]).toEqual(['events']);
  expect([
    ...highlightable(model, ['events', 'customer.events']).edges,
  ]).toEqual(['customer.events']);
  expect(layoutSignature(mapManifest({ ...manifest, datasets: [] }))).not.toBe(
    layoutSignature(model),
  );
  // Incomplete endpoints never become dangling graph edges.
  expect(mapManifest({ ...manifest, datasets: [] }).edges).toEqual([]);
});

it('retains every correlation pair and keeps layout stable across metadata edits', () => {
  const { graph } = createAnalyticalGraph();
  const { manifest } = compile(graph);
  const expanded = {
    ...manifest,
    objects: manifest.objects.map((object) => ({
      ...object,
      datasets: object.datasets?.map((association) => ({
        ...association,
        on: [
          ...association.on,
          {
            columnDefinitionId: 'events.secret',
            propertyDefinitionId: 'customer.label',
          },
        ],
      })),
    })),
  };
  const model = mapManifest(expanded);

  expect(model.edges[0]!.data).toMatchObject({
    on: [
      { column: 'customerId', property: 'externalId' },
      { column: 'secret', property: 'label' },
    ],
  });
  const relabelled = mapManifest({
    ...expanded,
    datasets: expanded.datasets!.map((dataset) => ({
      ...dataset,
      apiName: 'RenamedEvents',
      description: 'Changed documentation.',
    })),
  });

  expect(layoutSignature(relabelled)).toBe(layoutSignature(model));
  expect(
    describeDatasetType({ type: 'timestamp', precision: 6, nullable: true }),
  ).toBe('timestamp(6) | null');
});

it('shows dataset access groups, association role and computed declarations in selection details', () => {
  const { graph } = createAnalyticalGraph();
  const model = mapManifest(compile(graph).manifest);
  const render = (selected: string) =>
    renderToStaticMarkup(
      createElement(SidePanel, {
        state: initialState,
        model,
        selected,
        highlights: {
          nodes: new Map<string, number>(),
          edges: new Set<string>(),
        },
        onSelect: () => {},
        onClose: () => {},
      }),
    );

  const dataset = render('events');

  expect(dataset).toContain('Selected dataset');
  expect(dataset).toContain('Columns');
  expect(dataset).toContain('int64');
  expect(dataset).toContain('Group: private · role: private');
  expect(dataset).toContain('Required role: analyst');
  expect(dataset).toContain('Events.customerId = Customer.externalId');
  const association = render('customer.events');

  expect(association).toContain('Selected dataset association');
  expect(association).toContain('Events.customerId = Customer.externalId');
  const object = render('customer');

  expect(object).toContain('Computed properties');
  expect(object).toContain('customer.count');
  expect(object).toContain('Dataset associations');

  for (const html of [dataset, association, object])
    expect(html).not.toContain('SELECT');
});

it('docks associated datasets under their objects instead of drawing them as cards', () => {
  const { graph } = createAnalyticalGraph();
  const model = mapManifest(compile(graph).manifest);

  const view = dockDatasets(model);

  expect(view.nodes.map((node) => node.id)).toEqual(['customer']);
  expect(view.edges).toEqual([]);
  expect(
    view.docks
      .get('customer')
      ?.map(({ dataset, association }) => [dataset.id, association.id]),
  ).toEqual([['events', 'customer.events']]);
});

it('keeps a dataset no object joins on the canvas', () => {
  const { graph } = createAnalyticalGraph();
  const model = mapManifest(compile(graph).manifest);
  const unjoined = {
    nodes: model.nodes,
    edges: model.edges.filter((edge) => edge.data.kind !== 'association'),
  };

  const view = dockDatasets(unjoined);

  expect(view.nodes.map((node) => node.id)).toEqual(['customer', 'events']);
  expect(view.docks.size).toBe(0);
});
