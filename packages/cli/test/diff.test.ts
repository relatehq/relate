import { expect, it } from 'vitest';
import { compile } from 'relate/compiler';
import type { Manifest } from 'relate/model';
import { describeManifest, diffManifests, summarizeDiff } from '@relate/cli';
import {
  Customer,
  CustomerInvoices,
  Invoice,
  graph,
} from '../../../dev/fixtures/customer-graph/invoice-read/model.js';

const base = compile(graph).manifest;

function withProperty(manifest: Manifest, objectId: string, name: string) {
  return {
    ...manifest,
    objects: manifest.objects.map((o) =>
      o.id === objectId
        ? {
            ...o,
            properties: [
              ...o.properties,
              {
                id: `${objectId}.${name}`,
                name,
                access: 'ordinary',
                schema: {
                  type: 'number' as const,
                  optional: false,
                  nullable: false,
                },
                origin: { kind: 'native' as const },
              },
            ],
          }
        : o,
    ),
  };
}

it('diffs objects and relationships by stable ID and flags other sections', () => {
  expect(diffManifests(null, base)).toEqual({
    objects: { added: [Customer.id, Invoice.id], changed: [], removed: [] },
    relationships: { added: [CustomerInvoices.id], changed: [], removed: [] },
    otherChanged: true,
  });
  expect(diffManifests(base, base)).toEqual({
    objects: { added: [], changed: [], removed: [] },
    relationships: { added: [], changed: [], removed: [] },
    otherChanged: false,
  });

  const grown = withProperty(base, Customer.id, 'score');
  const diff = diffManifests(base, grown);

  expect(diff.objects).toEqual({
    added: [],
    changed: [Customer.id],
    removed: [],
  });
  expect(diff.otherChanged).toBe(false);

  const policyChange = {
    ...base,
    policies: {
      ...base.policies,
      [Invoice.id]: {
        ...base.policies[Invoice.id]!,
        read: { ...base.policies[Invoice.id]!.read, role: 'finance' },
      },
    },
  };

  expect(diffManifests(base, policyChange)).toEqual({
    objects: { added: [], changed: [], removed: [] },
    relationships: { added: [], changed: [], removed: [] },
    otherChanged: true,
  });

  const { relationships, ...withoutRelationships } = base;

  void relationships;
  expect(diffManifests(base, withoutRelationships).relationships).toEqual({
    added: [],
    changed: [],
    removed: [CustomerInvoices.id],
  });
});

it('summarizes at most three changes with display names and a remainder count', () => {
  expect(summarizeDiff(base, base)).toBe('model unchanged');
  expect(summarizeDiff(base, withProperty(base, Customer.id, 'score'))).toBe(
    '+Customer.score',
  );
  expect(
    summarizeDiff(base, {
      ...base,
      policies: {
        ...base.policies,
        [Invoice.id]: {
          ...base.policies[Invoice.id]!,
          read: { ...base.policies[Invoice.id]!.read, role: 'finance' },
        },
      },
    }),
  ).toBe('~policy Invoice');

  const { relationships, ...withoutRelationships } = base;

  void relationships;
  expect(summarizeDiff(base, withoutRelationships)).toBe('-Customer.invoices');

  const many = withProperty(
    withProperty(
      withProperty(withProperty(base, Customer.id, 'a'), Customer.id, 'b'),
      Invoice.id,
      'c',
    ),
    Invoice.id,
    'd',
  );

  expect(summarizeDiff(base, many)).toBe(
    '+Customer.a +Customer.b +Invoice.c (+1 changes)',
  );
  expect(summarizeDiff(null, base)).toBe(
    '+Customer +Invoice +Customer.invoices',
  );
});

it('describes an accepted model for the ready line', () => {
  expect(describeManifest(base)).toBe(
    'invoice-read  2 objects · 2 sources · 1 relationship',
  );
});
