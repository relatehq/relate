import { expect, it } from 'vitest';
import { defineObject } from 'relate';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import { createCustomerGraph } from '../../../tests/support/customer-graph.js';

it('keeps API addressing and durable identity independent of display metadata', () => {
  const { Customer, customerGraph } = createCustomerGraph();

  const original = compile(customerGraph);
  const model = compile({
    ...customerGraph,
    objects: {
      Customer: defineObject({
        ...Customer,
        label: 'Client account',
        pluralLabel: 'Client accounts',
        description: 'Organizations that purchase our services.',
      }),
    },
  });

  expect(model.manifest.objects[0]).toEqual({
    ...original.manifest.objects[0],
    apiName: 'Customer',
    label: 'Client account',
    pluralLabel: 'Client accounts',
    description: 'Organizations that purchase our services.',
  });
  expect(model.manifest.policies).toEqual(original.manifest.policies);
  expect(model.definitionRevision).not.toBe(original.definitionRevision);
  expect(validateManifest(JSON.parse(JSON.stringify(model.manifest)))).toEqual(
    model.manifest,
  );
});

it.each([
  ['AccountReview', 'Account Review'],
  ['accountReview', 'Account Review'],
  ['CRMAccount', 'CRM Account'],
  ['account_review', 'Account review'],
])(
  'resolves omitted labels from %s without guessing plurals',
  (apiName, label) => {
    const { Customer, customerGraph } = createCustomerGraph();

    const object = defineObject({
      id: Customer.id,
      membership: Customer.membership,
      properties: Customer.properties,
    });
    const model = compile({
      ...customerGraph,
      objects: { [apiName]: object },
      policies: { [apiName]: customerGraph.policies.Customer },
    });

    expect(model.manifest.objects[0]).toMatchObject({
      id: Customer.id,
      apiName,
      label,
      pluralLabel: label,
    });
    expect(model.manifest.objects[0]).not.toHaveProperty('description');
    expect(object).not.toHaveProperty('label');
  },
);

it('uses explicit singular and irregular plural labels independently', () => {
  const { Customer, customerGraph } = createCustomerGraph();

  for (const metadata of [
    { label: 'Person' },
    { pluralLabel: 'People' },
    { label: 'Person', pluralLabel: 'People' },
  ]) {
    const model = compile({
      ...customerGraph,
      objects: {
        Person: {
          id: Customer.id,
          membership: Customer.membership,
          properties: Customer.properties,
          ...metadata,
        },
      },
      policies: { Person: customerGraph.policies.Customer },
    });

    expect(model.manifest.objects[0]).toMatchObject({
      apiName: 'Person',
      label: 'Person',
      pluralLabel: metadata.pluralLabel ?? 'Person',
    });
  }
});

it('allows shared display labels but rejects duplicate API names in loaded manifests', () => {
  const { customerGraph } = createCustomerGraph();

  const manifest = structuredClone(compile(customerGraph).manifest);
  const object = manifest.objects[0]!;

  manifest.objects.push({
    ...object,
    id: 'other.customer',
    apiName: 'OtherCustomer',
    properties: object.properties.map((property) => ({
      ...property,
      id: `other.${property.id}`,
    })),
  });
  expect(() => validateManifest(manifest)).not.toThrow();
  manifest.objects[1]!.apiName = object.apiName;
  expect(() => validateManifest(manifest)).toThrow(/object API name/);
});

it.each(['', ' ', '__proto__', 'constructor', 'prototype'])(
  'rejects invalid API name %j during compilation and manifest loading',
  (apiName) => {
    const { Customer, customerGraph } = createCustomerGraph();

    expect(() =>
      compile({
        ...customerGraph,
        objects: { [apiName]: Customer },
        policies: { [apiName]: customerGraph.policies.Customer },
      }),
    ).toThrow();
    const manifest = structuredClone(compile(customerGraph).manifest);

    manifest.objects[0]!.apiName = apiName;
    expect(() => validateManifest(manifest)).toThrow();
  },
);

it.each(['label', 'pluralLabel'] as const)('rejects blank %s', (field) => {
  const { Customer, customerGraph } = createCustomerGraph();

  for (const value of ['', ' ']) {
    expect(() =>
      compile({
        ...customerGraph,
        objects: { Customer: { ...Customer, [field]: value } },
      }),
    ).toThrow();
    const manifest = structuredClone(compile(customerGraph).manifest);

    manifest.objects[0]![field] = value;
    expect(() => validateManifest(manifest)).toThrow();
  }
});

it('requires recompilation of manifests from the previous naming contract', () => {
  const { customerGraph } = createCustomerGraph();

  const manifest = structuredClone(compile(customerGraph).manifest);
  const {
    apiName: _apiName,
    label,
    pluralLabel: _pluralLabel,
    ...object
  } = manifest.objects[0]!;

  expect(() =>
    validateManifest({
      ...manifest,
      formatVersion: 1,
      objects: [{ ...object, name: label }],
    }),
  ).toThrow();
});
