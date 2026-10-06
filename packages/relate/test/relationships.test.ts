import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import {
  graph,
  Customer,
  Invoice,
  CustomerInvoices,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

it('compiles both traversal directions through one registered reference', () => {
  expect(compile(graph).manifest.relationships).toEqual([
    {
      id: CustomerInvoices.id,
      fromObjectDefinitionId: Customer.id,
      toObjectDefinitionId: Invoice.id,
      referencePropertyDefinitionId: Invoice.properties.customer.id,
      forward: { name: 'invoices', cardinality: 'many' },
      reverse: { name: 'customer', cardinality: 'one' },
    },
  ]);
});

it('rejects unregistered authoring endpoints and references instead of trusting same IDs', () => {
  for (const relation of [
    { ...CustomerInvoices, from: { ...Customer } },
    { ...CustomerInvoices, via: { ...Invoice.properties.customer } },
  ])
    expect(() => compile({ ...graph, relationships: { relation } })).toThrow(
      'Unregistered',
    );
});

it('validates portable endpoint, reference, cardinality and traversal-name contracts', () => {
  const original = compile(graph).manifest;

  for (const mutate of [
    (m: typeof original) => {
      m.relationships![0]!.fromObjectDefinitionId = 'missing';
    },
    (m: typeof original) => {
      m.relationships![0]!.toObjectDefinitionId = Customer.id;
    },
    (m: typeof original) => {
      m.relationships![0]!.referencePropertyDefinitionId =
        Invoice.properties.status.id;
    },
    (m: typeof original) => {
      m.relationships![0]!.forward.name = '__proto__';
    },
    (m: typeof original) => {
      m.relationships![0]!.reverse.name = 'constructor';
    },
    (m: typeof original) => {
      m.relationships!.push({ ...m.relationships![0]!, id: 'duplicate-names' });
    },
    (m: typeof original) => {
      m.relationships![0]!.id = Invoice.id;
    },
  ]) {
    const manifest = structuredClone(original);

    mutate(manifest);
    expect(() => validateManifest(manifest)).toThrow();
  }

  const invalid = structuredClone(original);

  Object.assign(invalid.relationships![0]!.forward, { cardinality: 'one' });
  expect(() => validateManifest(invalid)).toThrow();
});
