import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineAction, implementAction } from 'relate';
import { compile } from 'relate/compiler';
import { validateManifest } from 'relate/model';
import { createRuntime } from '@relate/node';
import {
  graph,
  AddAccountReview,
  Customer,
  AccountReview,
  addAccountReview,
} from '../../../tests/support/native-action-model.js';

it('compiles native membership, reference identity, create authorization and action contracts', () => {
  const compiled = compile(graph);

  expect(compiled.manifest.actions).toEqual([
    {
      id: AddAccountReview.id,
      apiName: 'addAccountReview',
      creates: [AccountReview.id],
      execute: { role: 'account-manager' },
      input: {
        customer: {
          type: 'string',
          optional: false,
          nullable: false,
          references: Customer.id,
        },
        note: {
          type: 'string',
          optional: false,
          nullable: false,
          minLength: 1,
          maxLength: 4000,
        },
      },
      output: {
        reviewId: {
          type: 'string',
          optional: false,
          nullable: false,
          references: AccountReview.id,
        },
      },
    },
  ]);
  expect(compiled.manifest.createPolicies?.[AccountReview.id]?.where).toEqual({
    all: [
      { path: ['review.customer', 'customer.portfolio'], claim: 'portfolio' },
      { path: ['review.author'], actor: 'id' },
    ],
  });
  expect(JSON.parse(JSON.stringify(compiled))).toEqual(compiled);
  expect(compile(graph)).toEqual(compiled);
});

it('does not silently accept unsupported action schemas', () => {
  for (const input of [
    z.object({ value: z.string().refine((v) => v.length > 0) }),
    z.object({ value: z.string().transform(Number) }),
    z.object({ value: z.object({ nested: z.string() }) }),
  ]) {
    expect(() =>
      compile({
        ...graph,
        actions: { addAccountReview: { ...AddAccountReview, input } },
      }),
    ).toThrow();
  }
});

it('validates action capabilities, registration and policy operands after serialization', () => {
  for (const change of [
    (m: ReturnType<typeof compile>['manifest']) => {
      m.actions![0]!.creates = [Customer.id];
    },
    (m: ReturnType<typeof compile>['manifest']) => {
      m.actions![0]!.execute = { role: 'unknown' };
    },
    (m: ReturnType<typeof compile>['manifest']) => {
      m.actions![0]!.input.customer!.references = 'missing';
    },
    (m: ReturnType<typeof compile>['manifest']) => {
      m.createPolicies![Customer.id] = m.createPolicies![AccountReview.id]!;
    },
    (m: ReturnType<typeof compile>['manifest']) => {
      m.createPolicies![AccountReview.id]!.where = {
        all: [{ path: ['review.author'] }],
      };
    },
  ]) {
    const manifest = structuredClone(compile(graph).manifest);

    change(manifest);
    expect(() => validateManifest(manifest)).toThrow();
  }

  expect(() =>
    implementAction(
      graph,
      defineAction({ ...AddAccountReview, id: 'other' }) as never,
      async () => {
        throw new Error('unreachable');
      },
    ),
  ).toThrow('Unregistered');
});

it('requires exactly one matching server implementation per registered action', () => {
  expect(() => createRuntime({ graph, connections: [] })).toThrow(
    'Missing action implementation',
  );
  expect(() =>
    createRuntime({
      graph,
      connections: [],
      actionImplementations: [addAccountReview, addAccountReview],
    }),
  ).toThrow('Duplicate action implementation');
});
