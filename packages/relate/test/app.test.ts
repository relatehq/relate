import { expect, it } from 'vitest';
import { defineApp, isAppDefinition, defineAccess, defineGraph } from 'relate';

const access = defineAccess({ roles: [], fieldGroups: [], claims: {} });
const graph = defineGraph({ id: 'app', objects: {}, access, policies: {} });

it('defines an inert descriptor that exposes the graph without calling setup', () => {
  let calls = 0;
  const app = defineApp({
    graph,
    setup() {
      calls += 1;

      return { connections: [] };
    },
  });

  expect(app.kind).toBe('relate.app');
  expect(app.graph).toBe(graph);
  expect(Object.isFrozen(app)).toBe(true);
  expect(calls).toBe(0);
  expect(isAppDefinition(app)).toBe(true);
  expect(isAppDefinition(JSON.parse(JSON.stringify({ ...app })))).toBe(true);
  expect(isAppDefinition(graph)).toBe(false);
  expect(isAppDefinition(null)).toBe(false);
  expect(() => defineApp({} as never)).toThrow('requires a graph');
  expect(() => defineApp({ graph, setup: 'later' } as never)).toThrow(
    'setup must be a function',
  );
  expect(defineApp({ graph }).setup).toBeUndefined();
});
