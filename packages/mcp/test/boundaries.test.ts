import { expect, it } from 'vitest';
import { assertPackageImport } from '../../../tests/architecture/package-boundaries.js';

it.each([
  '@relate/node',
  'relate/compiler',
  '@modelcontextprotocol/client',
  'relate',
])('keeps %s available only to the package example', (name) => {
  expect(() =>
    assertPackageImport('packages/mcp', 'src/server.ts', name),
  ).toThrow('Forbidden dependency');
  expect(() =>
    assertPackageImport('packages/mcp', 'src/examples/bypass.ts', name),
  ).toThrow('Forbidden dependency');
  expect(() =>
    assertPackageImport(
      'packages/mcp',
      'examples/discovery-query-action.ts',
      name,
    ),
  ).not.toThrow();
});
