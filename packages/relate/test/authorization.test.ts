import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineAccess, equals } from 'relate';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import {
  access,
  Customer,
  customerGraph,
} from '../../../examples/postgres-persistence/src/model.js';

it('lowers object and property references into a portable policy', () => {
  const manifest = compile(customerGraph).manifest;

  expect(manifest.roles).toEqual(['employee', 'finance']);
  expect(manifest.claims).toEqual({
    portfolio: { type: 'string', optional: false, nullable: false },
  });
  expect(manifest.policies).toEqual({
    'business.customer': {
      read: {
        role: 'employee',
        where: {
          propertyDefinitionId: 'business.customer.portfolio',
          claim: 'portfolio',
        },
        evidenceMaxAgeMs: 30_000,
      },
      groups: { financial: { role: 'finance' } },
    },
  });
  expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(
    manifest,
  );
});

it('rejects duplicate and unregistered policy objects before lowering', () => {
  expect(() =>
    compile({
      ...customerGraph,
      policies: [...customerGraph.policies, ...customerGraph.policies],
    }),
  ).toThrow(/Duplicate policy object/);
  expect(() => compile({ ...customerGraph, objects: [] })).toThrow(
    /Unknown policy object/,
  );
});

it('validates role, claim, group and comparison contracts in loaded manifests', () => {
  const original = compile(customerGraph).manifest;
  const mutations: Array<[(manifest: typeof original) => void, RegExp]> = [
    [
      (m) => {
        m.policies[Customer.id]!.read.role = 'employe';
      },
      /Unknown policy role/,
    ],
    [
      (m) => {
        m.policies[Customer.id]!.groups.financial!.role = 'financ';
      },
      /Unknown policy role/,
    ],
    [
      (m) => {
        const where = m.policies[Customer.id]!.read.where!;

        if ('claim' in where) where.claim = 'portoflio';
      },
      /Unknown policy claim/,
    ],
    [
      (m) => {
        m.claims.portfolio!.type = 'number';
      },
      /Incompatible policy claim/,
    ],
    [
      (m) => {
        m.claims.portfolio!.nullable = true;
      },
      /Incompatible policy claim/,
    ],
    [
      (m) => {
        m.claims.portfolio!.optional = true;
      },
      /Incompatible policy claim/,
    ],
    [
      (m) => {
        m.policies[Customer.id]!.groups.financal = {
          role: 'finance',
        };
      },
      /Invalid policy group/,
    ],
    [
      (m) => {
        m.objects[0]!.properties[0]!.access = 'financal';
      },
      /Unknown field group/,
    ],
    [
      (m) => {
        m.roles.push('employee');
      },
      /Invalid roles/,
    ],
  ];

  for (const [mutate, error] of mutations) {
    const manifest = structuredClone(original);

    mutate(manifest);
    expect(() => validateManifest(manifest)).toThrow(error);
  }
});

it('checks erased JavaScript inputs and conflicting claim references', () => {
  const policy = customerGraph.policies[0]!;
  const compileRead = (read: unknown) =>
    compile({ ...customerGraph, policies: [{ ...policy, read }] } as never);

  expect(() =>
    compileRead({ ...policy.read, gate: { kind: 'role', role: 'employe' } }),
  ).toThrow(/Unknown policy role/);
  expect(() =>
    compileRead({
      ...policy.read,
      where: {
        ...policy.read.where,
        claim: { ...access.claims.portfolio, name: 'portoflio' },
      },
    }),
  ).toThrow(/Unknown policy claim/);
  const foreign = defineAccess({
    roles: [],
    fieldGroups: ['ordinary'],
    claims: { portfolio: z.number() },
  });

  expect(() =>
    compileRead({
      ...policy.read,
      where: equals(Customer.properties.revenue, foreign.claims.portfolio),
    }),
  ).toThrow(/Conflicting policy reference/);
  const numeric = defineAccess({
    roles: ['employee'],
    fieldGroups: ['ordinary', 'financial'],
    claims: { portfolio: z.number() },
  });

  expect(() =>
    compile({
      ...customerGraph,
      access: numeric,
      policies: [
        {
          ...policy,
          groups: {},
          read: {
            ...policy.read,
            where: {
              kind: 'equals',
              property: Customer.properties.portfolio,
              claim: numeric.claims.portfolio,
            },
          },
        },
      ],
    }),
  ).toThrow(/Incompatible policy claim/);
});

it('does not silently lower unsupported authoring operators', () => {
  const policy = customerGraph.policies[0]!;

  for (const read of [
    { ...policy.read, gate: { kind: 'any', role: 'employee' } },
    { ...policy.read, where: { ...policy.read.where, kind: 'not-equals' } },
  ]) {
    expect(() =>
      compile({ ...customerGraph, policies: [{ ...policy, read }] } as never),
    ).toThrow(/Unsupported policy/);
  }
});
