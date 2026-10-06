import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import {
  access,
  Customer,
  graph,
  Invoice,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

it('lowers source references and nested predicates to stable definition paths', () => {
  const model = compile(graph);

  expect(
    model.manifest.objects
      .find((o) => o.id === Invoice.id)
      ?.properties.find((p) => p.name === 'customer')?.origin,
  ).toEqual({
    kind: 'reference',
    sourceDefinitionId: 'billing.invoices',
    field: 'customer_id',
    targetObjectDefinitionId: Customer.id,
  });
  expect(model.manifest.policies[Invoice.id]?.read.where).toEqual({
    all: [
      { path: ['invoice.customer', 'customer.portfolio'], claim: 'portfolio' },
    ],
  });
  expect(validateManifest(JSON.parse(JSON.stringify(model.manifest)))).toEqual(
    model.manifest,
  );
});

it('rejects unknown targets, incompatible keys, and invalid nested paths in portable manifests', () => {
  const original = compile(graph).manifest;

  for (const mutate of [
    (m: typeof original) => {
      m.objects = m.objects.filter((o) => o.id !== Customer.id);
    },
    (m: typeof original) => {
      m.sources.find(
        (s) => s.id === 'billing.invoices',
      )!.fields.customer_id!.type = 'number';
    },
    (m: typeof original) => {
      m.sources.find(
        (s) => s.id === 'billing.invoices',
      )!.fields.customer_id!.optional = true;
    },
    (m: typeof original) => {
      m.policies[Invoice.id]!.read.where = {
        all: [
          {
            path: ['invoice.status', 'customer.portfolio'],
            claim: 'portfolio',
          },
        ],
      };
    },
    (m: typeof original) => {
      m.policies[Invoice.id]!.read.where = {
        all: [
          {
            path: ['invoice.customer', 'customer.unknown'],
            claim: 'portfolio',
          },
        ],
      };
    },
    (m: typeof original) => {
      m.policies[Invoice.id]!.read.where = {
        all: [{ path: ['invoice.total'], claim: 'portfolio' }],
      };
    },
    (m: typeof original) => {
      m.policies[Invoice.id]!.read.where = {
        all: [{ path: ['invoice.customer'], claim: 'portfolio' }],
      };
    },
  ]) {
    const manifest = structuredClone(original);

    mutate(manifest);
    expect(() => validateManifest(manifest)).toThrow();
  }
});

it('rejects erased invalid nested authoring input before it can become permission', () => {
  for (const where of [
    undefined,
    null,
    false,
    {},
    { customer: {} },
    { customer: { typo: { eq: access.claims.portfolio } } },
    { status: { eq: access.claims.portfolio, ignored: true } },
  ]) {
    expect(() =>
      compile({
        ...graph,
        policies: {
          ...graph.policies,
          Invoice: {
            read: {
              gate: access.role('employee'),
              evidenceMaxAgeMs: 1000,
              where,
            },
          },
        },
      } as never),
    ).toThrow();
  }

  expect(() =>
    compile({
      ...graph,
      objects: { Invoice },
      policies: {
        Invoice: {
          read: {
            gate: access.role('employee'),
            evidenceMaxAgeMs: 1000,
            where: { customer: { portfolio: { eq: access.claims.portfolio } } },
          },
        },
      },
    } as never),
  ).toThrow('Unknown reference target');
});
