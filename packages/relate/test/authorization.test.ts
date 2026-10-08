import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineAccess } from 'relate';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import {
  access,
  Customer,
  customerGraph,
} from '../../../examples/04-postgres-persistence/src/model.js';

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
          all: [{ path: ['business.customer.portfolio'], claim: 'portfolio' }],
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
      objects: { Customer, Duplicate: Customer },
      policies: { ...customerGraph.policies, Duplicate: { read: 'deny' } },
    }),
  ).toThrow(/Duplicate object definition/);
  expect(() => compile({ ...customerGraph, objects: {} })).toThrow(
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

        if ('all' in where) where.all[0]!.claim = 'portoflio';
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
  const policy = customerGraph.policies.Customer!;
  const compileRead = (read: unknown) =>
    compile({
      ...customerGraph,
      policies: { Customer: { ...policy, read } },
    } as never);

  expect(() =>
    compileRead({ ...policy.read, gate: { kind: 'role', role: 'employe' } }),
  ).toThrow(/Unknown policy role/);
  expect(() =>
    compileRead({
      ...policy.read,
      where: {
        portfolio: { eq: { ...access.claims.portfolio, name: 'portoflio' } },
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
      where: { revenue: { eq: foreign.claims.portfolio } },
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
      policies: {
        Customer: {
          ...policy,
          groups: {},
          read: {
            ...policy.read,
            where: {
              portfolio: { eq: numeric.claims.portfolio },
            },
          },
        },
      },
    }),
  ).toThrow(/Incompatible policy claim/);
});

it('does not silently lower unsupported authoring operators', () => {
  const policy = customerGraph.policies.Customer!;

  for (const read of [
    { ...policy.read, gate: { kind: 'any', role: 'employee' } },
    { ...policy.read, where: { ...policy.read.where, kind: 'not-equals' } },
  ]) {
    expect(() =>
      compile({
        ...customerGraph,
        policies: { Customer: { ...policy, read } },
      } as never),
    ).toThrow(/Unsupported policy|Unknown policy dependency/);
  }
});

it('requires explicit authoring coverage and lowers deny to runtime default-deny', () => {
  expect(() => compile({ ...customerGraph, policies: {} })).toThrow(
    'Missing policy: Customer',
  );
  expect(() =>
    compile({ ...customerGraph, policies: { Customer: {} } } as never),
  ).toThrow('Invalid policy read rule');
  expect(() =>
    compile({
      ...customerGraph,
      policies: { Customer: { read: 'deny', groups: {} } },
    } as never),
  ).toThrow('Denied reads cannot grant field groups');
  const denied = compile({
    ...customerGraph,
    policies: { Customer: { read: 'deny' } },
  });

  expect(denied.manifest.policies).toEqual({});
  expect(validateManifest(JSON.parse(JSON.stringify(denied.manifest)))).toEqual(
    denied.manifest,
  );
});

it('requires keyed registries even for untyped callers', () => {
  expect(() =>
    compile({ ...customerGraph, objects: [Customer] } as never),
  ).toThrow('keyed registries');
  expect(() => compile({ ...customerGraph, policies: [] } as never)).toThrow(
    'keyed registries',
  );
});

it('rejects erased freshness mistakes and empty or malformed predicates', () => {
  const gate = access.role('employee');

  for (const read of [
    { gate, evidenceMaxAgeMs: 1000 },
    { gate, where: { portfolio: { eq: access.claims.portfolio } } },
    { gate, where: {}, evidenceMaxAgeMs: 1000 },
    { gate, where: undefined, evidenceMaxAgeMs: 1000 },
    {
      gate,
      where: { portfolio: { eq: access.claims.portfolio } },
      evidenceMaxAgeMs: -1,
    },
  ]) {
    expect(() =>
      compile({ ...customerGraph, policies: { Customer: { read } } } as never),
    ).toThrow();
  }
});
