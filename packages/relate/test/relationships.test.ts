import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import { defineObject, defineRelationship, reference } from 'relate';
import { createInvoiceGraph } from '../../../tests/support/invoice-graph.js';

const { graph, Customer, Invoice, CustomerInvoices, invoices } =
  createInvoiceGraph();

it('binds fresh immutable properties without mutating or sharing their owner', () => {
  const customer = reference(Customer, {
    id: 'invoice.customer',
    from: invoices.fields.customer_id,
  });
  const first = defineObject({
    ...Invoice,
    properties: { ...Invoice.properties, customer },
  });
  const second = defineObject({ ...first, id: 'other.invoice' });

  expect(customer).not.toHaveProperty('owner');
  expect(first.properties.customer).not.toBe(customer);
  expect(second.properties.customer).not.toBe(first.properties.customer);

  for (const object of [first, second]) {
    expect(Object.isFrozen(object)).toBe(true);
    expect(Object.isFrozen(object.properties)).toBe(true);

    for (const property of Object.values(object.properties)) {
      expect(property.owner).toBe(object);
      expect(Object.isFrozen(property)).toBe(true);
    }

    const relationship = defineRelationship({
      id: 'customer-invoices',
      via: object.properties.customer,
      forward: 'invoices',
      reverse: 'customer',
    });

    expect(relationship.from).toBe(Customer);
    expect(relationship.to).toBe(object);
    expect(relationship.via).toBe(object.properties.customer);
  }

  expect(Invoice.properties.customer.owner).toBe(Invoice);
  expect(first.properties.customer.owner).toBe(first);
});

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
    { ...CustomerInvoices, to: { ...Invoice } },
    { ...CustomerInvoices, via: { ...Invoice.properties.customer } },
  ])
    expect(() => compile({ ...graph, relationships: { relation } })).toThrow(
      'Unregistered',
    );
});

it('rejects a reference targeting a same-ID object outside the graph', () => {
  const invoice = defineObject({
    ...Invoice,
    properties: {
      ...Invoice.properties,
      customer: reference(
        { ...Customer },
        {
          id: Invoice.properties.customer.id,
          from: invoices.fields.customer_id,
        },
      ),
    },
  });
  const relationship = defineRelationship({
    id: CustomerInvoices.id,
    via: invoice.properties.customer,
    forward: 'invoices',
    reverse: 'customer',
  });

  expect(() =>
    compile({
      ...graph,
      objects: { Customer, Invoice: invoice },
      relationships: { relationship },
    }),
  ).toThrow('Unregistered');
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
