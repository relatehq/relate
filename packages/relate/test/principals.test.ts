import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineAccess,
  defineGraph,
  defineObject,
  nativeMembership,
  native,
  objectId,
} from 'relate';
import type { GraphDefinition } from 'relate';
import { CompileError, compile } from 'relate/compiler';

function createNoteGraph(
  principals?: GraphDefinition['principals'],
): GraphDefinition {
  const access = defineAccess({
    roles: ['reader', 'finance'],
    fieldGroups: ['ordinary'],
    claims: { region: z.string().max(2).nullable(), limit: z.number() },
  });
  const Note = defineObject({
    id: 'notes.note',
    membership: nativeMembership(),
    properties: {
      id: objectId({ id: 'note.id' }),
      body: native(z.string(), { id: 'note.body' }),
    },
  });

  const graph = defineGraph({
    id: 'notes',
    objects: { Note },
    access,
    policies: { Note: { read: { gate: access.role('reader') } } },
  });

  return principals ? { ...graph, principals } : graph;
}

function issuesOf(graph: GraphDefinition) {
  try {
    compile(graph);
  } catch (error) {
    if (error instanceof CompileError) return error.issues;

    throw error;
  }

  throw new Error('Expected a compile error');
}

it('returns development principals outside the Manifest in declaration order', () => {
  const graph = createNoteGraph({
    alice: { roles: ['reader'], claims: { region: 'eu', limit: 10 } },
    auditor: { roles: ['reader', 'finance'], claims: { region: null } },
  });

  const model = compile(graph);

  expect(model.principals).toEqual({
    alice: { roles: ['reader'], claims: { region: 'eu', limit: 10 } },
    auditor: { roles: ['reader', 'finance'], claims: { region: null } },
  });
  expect(Object.keys(model.principals)).toEqual(['alice', 'auditor']);
  expect(JSON.stringify(model.manifest)).not.toContain('alice');
  expect(Object.isFrozen(model.principals.alice)).toBe(true);
});

it('keeps definitionRevision independent of development principals', () => {
  const without = createNoteGraph();
  const withAlice = createNoteGraph({ alice: { roles: ['reader'] } });
  const withBoth = createNoteGraph({
    alice: { roles: ['finance'], claims: { region: 'us' } },
    bob: { roles: ['reader'] },
  });

  const revisions = [without, withAlice, withBoth].map(
    (graph) => compile(graph).definitionRevision,
  );

  expect(new Set(revisions).size).toBe(1);
  expect(compile(without).principals).toEqual({});
});

it('reports unknown roles and claims and invalid claim values as compile issues', () => {
  const graph = createNoteGraph({
    alice: {
      roles: ['reader', 'admin'],
      claims: { region: 'mars', team: 'core', limit: 5 },
    },
    'bad name': { roles: ['reader'] },
  } as unknown as GraphDefinition['principals']);

  const issues = issuesOf(graph);

  expect(
    issues.map((issue) => [issue.code, issue.path?.segments.join('.')]),
  ).toEqual(
    expect.arrayContaining([
      ['principal.unknown-role', 'principals.alice.roles.1'],
      ['principal.invalid-claim', 'principals.alice.claims.region'],
      ['principal.unknown-claim', 'principals.alice.claims.team'],
      ['principal.invalid-name', 'principals.bad name'],
    ]),
  );
  expect(issues).toHaveLength(4);
  expect(issues.every((issue) => issue.path?.root === 'graph')).toBe(true);
});

it('rejects a principal without a roles array', () => {
  const graph = createNoteGraph({
    alice: { claims: { limit: 1 } },
  } as unknown as GraphDefinition['principals']);

  const issues = issuesOf(graph);

  expect(issues).toEqual([
    expect.objectContaining({
      code: 'principal.invalid-shape',
      path: { root: 'graph', segments: ['principals', 'alice'] },
    }),
  ]);
});
