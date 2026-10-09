import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import {
  describeScalar,
  estimateNodeSize,
  highlightable,
  layoutSignature,
  mapManifest,
} from '../src/graph/map.js';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { Customer, CustomerInvoices, Invoice, graph } = createInvoiceGraph();

const { manifest } = compile(graph);

it('maps object types to nodes with ownership and typed properties, identity first', () => {
  const model = mapManifest(manifest);

  expect(model.nodes.map((node) => node.id)).toEqual([Customer.id, Invoice.id]);
  const customer = model.nodes[0]!.data;

  expect(customer).toMatchObject({
    apiName: 'Customer',
    label: 'Customer',
    ownership: { kind: 'source', sourceId: 'crm.customers', tone: 1 },
  });
  expect(customer.properties.map((p) => [p.name, p.type, p.origin])).toEqual([
    ['id', 'string', 'object-id'],
    ['name', 'string', 'source'],
    ['portfolio', 'string', 'source'],
    ['revenue', 'number', 'source'],
  ]);
  expect(customer.properties.find((p) => p.name === 'revenue')?.access).toBe(
    'financial',
  );
  const invoice = model.nodes[1]!.data;
  const reference = invoice.properties.find((p) => p.name === 'customer');

  expect(reference).toMatchObject({
    origin: 'reference',
    target: Customer.id,
    field: 'customer_id',
  });
});

it('maps declared relationships to edges and never invents edges from references alone', () => {
  const model = mapManifest(manifest);

  expect(model.edges).toEqual([
    {
      id: CustomerInvoices.id,
      source: Customer.id,
      target: Invoice.id,
      data: {
        id: CustomerInvoices.id,
        forward: {
          name: 'invoices',
          cardinality: 'many',
          description: 'Invoices billed to this customer.',
        },
        reverse: {
          name: 'customer',
          cardinality: 'one',
          description: 'Customer billed by this invoice.',
        },
        viaProperty: 'customer',
      },
    },
  ]);

  const { relationships, ...withoutRelationships } = manifest;

  void relationships;
  expect(mapManifest(withoutRelationships).edges).toEqual([]);
  expect(mapManifest({ ...manifest, objects: [], relationships: [] })).toEqual({
    nodes: [],
    edges: [],
  });
});

it('describes optional and nullable scalars', () => {
  expect(
    describeScalar({ type: 'string', optional: false, nullable: false }),
  ).toBe('string');
  expect(
    describeScalar({ type: 'number', optional: true, nullable: false }),
  ).toBe('number?');
  expect(
    describeScalar({ type: 'boolean', optional: true, nullable: true }),
  ).toBe('boolean | null?');
});

it('changes the layout signature for topology changes only', () => {
  const model = mapManifest(manifest);
  const relabelled = mapManifest({
    ...manifest,
    objects: manifest.objects.map((o) => ({ ...o, label: `${o.label}!` })),
  });

  expect(layoutSignature(relabelled)).toBe(layoutSignature(model));
  expect(estimateNodeSize(model.nodes[0]!.data)).toEqual({
    width: 200,
    height: 60,
  });
  expect(
    layoutSignature(mapManifest({ ...manifest, relationships: [] })),
  ).not.toBe(layoutSignature(model));
  expect(
    layoutSignature(
      mapManifest({
        ...manifest,
        objects: manifest.objects.filter((o) => o.id === Customer.id),
        relationships: [],
      }),
    ),
  ).not.toBe(layoutSignature(mapManifest({ ...manifest, relationships: [] })));
});

it('highlights only unambiguous IDs present in the displayed model', () => {
  const model = mapManifest(manifest);
  const highlights = highlightable(model, [
    Customer.id,
    CustomerInvoices.id,
    'business.account-review',
  ]);

  expect([...highlights.nodes]).toEqual([Customer.id]);
  expect([...highlights.edges]).toEqual([CustomerInvoices.id]);
  expect(highlightable(null, [Customer.id]).nodes.size).toBe(0);

  // An ID that names both a node and an edge is ambiguous and never highlighted.
  const ambiguous = {
    nodes: model.nodes,
    edges: model.edges.map((edge) => ({ ...edge, id: Customer.id })),
  };

  expect(highlightable(ambiguous, [Customer.id]).nodes.size).toBe(0);
  expect(highlightable(ambiguous, [Customer.id]).edges.size).toBe(0);
});

it('maps many-to-many endpoints while retaining the junction details', async () => {
  const { createPlaylistGraph } =
    await import('../../../tests/support/playlist-graph.js');
  const { graph } = createPlaylistGraph();
  const model = mapManifest(compile(graph).manifest);

  expect(
    model.edges.find((edge) => edge.id === 'playlist.songs'),
  ).toMatchObject({
    source: 'playlist',
    target: 'song',
    data: {
      forward: { name: 'songs', cardinality: 'many' },
      reverse: { name: 'playlists', cardinality: 'many' },
      through: { objectId: 'membership', from: 'playlist', to: 'song' },
    },
  });
});
