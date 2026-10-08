import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { assertNoExampleDependencies } from './example-boundaries.js';

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'relate-example-boundary-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const write = async (file: string, contents: string) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), contents);
  };

  await write(
    'packages/node/package.json',
    JSON.stringify({ name: '@relate/node' }),
  );
  await write(
    'examples/demo/package.json',
    JSON.stringify({ name: '@relate/demo' }),
  );
  await write('examples/demo/src/graph.ts', 'export const graph = {};');
  await write(
    'connectors/sqlite/package.json',
    JSON.stringify({ name: '@relate/connector-sqlite' }),
  );

  return {
    root,
    write,
    packages: [
      { name: '@relate/node', path: join(root, 'packages/node') },
      { name: '@relate/demo', path: join(root, 'examples/demo') },
      {
        name: '@relate/connector-sqlite',
        path: join(root, 'connectors/sqlite'),
      },
    ],
  };
}

it.each([
  [
    'connectors/sqlite/test/read.test.ts',
    "import { graph } from '../../../examples/demo/src/graph.js';",
  ],
  [
    'packages/node/test/read.test.ts',
    "import { graph } from '../../../examples/demo/src/graph.js';",
  ],
  [
    'packages/node/test/support/fixture.ts',
    "export * from '../../../../examples/demo/src/graph.js';",
  ],
  [
    'packages/node/src/types.ts',
    "type Graph = import('../../../examples/demo/src/graph.js').Graph;",
  ],
  [
    'packages/node/test/read.test.ts',
    "const graph = await import('@relate/demo');",
  ],
  [
    'tests/support/graph.ts',
    "const graph = require('../../examples/demo/src/graph.js');",
  ],
  ['packages/node/src/graph.ts', "import type { Graph } from '@demo/graph';"],
])('rejects example coupling in %s', async (file, source) => {
  const { root, write, packages } = await workspace();

  await write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: { paths: { '@demo/*': ['./examples/demo/src/*'] } },
    }),
  );
  await write(file, source);
  await expect(assertNoExampleDependencies(root, packages)).rejects.toThrow(
    'Forbidden example dependency',
  );
});

it.each([
  [
    'packages/node/test/read.test.ts',
    "import { graph } from '../../../dev/fixtures/demo/model.js';",
  ],
  [
    'tests/support/graph.ts',
    "export * from '../../dev/fixtures/demo/model.js';",
  ],
])('rejects dev fixture coupling in %s', async (file, source) => {
  const { root, write, packages } = await workspace();

  await write('dev/fixtures/demo/model.ts', 'export const graph = {};');
  await write(file, source);
  await expect(assertNoExampleDependencies(root, packages)).rejects.toThrow(
    'Forbidden dev fixture dependency',
  );
});

it('rejects workspace dependencies on an example even without imports', async () => {
  const { root, write, packages } = await workspace();

  await write(
    'packages/node/package.json',
    JSON.stringify({
      name: '@relate/node',
      devDependencies: { '@relate/demo': 'workspace:*' },
    }),
  );
  await expect(assertNoExampleDependencies(root, packages)).rejects.toThrow(
    'Forbidden example dependency',
  );
});

it('allows test-owned helpers and tests of the example itself', async () => {
  const { root, write, packages } = await workspace();

  await write(
    'tests/support/graph.ts',
    'export const createGraph = () => ({});',
  );
  await write(
    'packages/node/test/read.test.ts',
    "import { createGraph } from '../../../tests/support/graph.js';",
  );
  await write(
    'examples/demo/test/graph.test.ts',
    "import { graph } from '../src/graph.js';",
  );
  await expect(
    assertNoExampleDependencies(root, packages),
  ).resolves.toBeUndefined();
});
