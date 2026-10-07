import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  assertRuntimeDependency,
  runtimeOwner,
} from '../architecture/runtime-boundaries.js';

const execFile = promisify(execFileCallback);

it.each([
  ['authorization/policy.ts', 'resolution/index.ts', true],
  ['observations/fetch.ts', 'actions/index.ts', false],
  ['actions/execute.ts', 'resolution/index.ts', false],
  ['actions/native.ts', 'resolution/request.ts', false],
  ['resolution/source.ts', 'actions/index.ts', false],
  ['traversal/traversal.ts', 'resolution/index.ts', true],
  ['resolution/source.ts', 'authorization/policy.ts', true],
  ['storage.ts', 'observations/index.ts', false],
  ['authorization/policy.ts', 'storage.ts', false],
  ['observations/fetch.ts', 'storage.ts', false],
  ['memory.ts', 'runtime.ts', false],
  ['reads/request.ts', 'index.ts', false],
] as const)('rejects forbidden runtime edge %s -> %s', (from, to, typeOnly) => {
  expect(() => assertRuntimeDependency(from, to, typeOnly)).toThrow(
    'Forbidden runtime dependency',
  );
});

it.each([
  ['runtime.ts', 'resolution/index.ts', false],
  ['runtime.ts', 'actions/index.ts', true],
  ['actions/native.ts', 'reads/index.ts', false],
  ['resolution/source.ts', 'authorization/index.ts', false],
  ['authorization/policy.ts', 'storage.ts', true],
  ['storage.ts', 'observations/ordering.ts', false],
  ['observations/ordering.ts', 'storage.ts', true],
  ['memory.ts', 'native-memory.ts', false],
] as const)('allows owned runtime edge %s -> %s', (from, to, typeOnly) => {
  expect(() => assertRuntimeDependency(from, to, typeOnly)).not.toThrow();
});

it('requires explicit ownership for new top-level modules', () => {
  expect(() => runtimeOwner('misc.ts')).toThrow('Unowned runtime module');
  expect(() => runtimeOwner('sync/worker.ts')).toThrow(
    'Unowned runtime module',
  );
});

// Exercise the CLI parser too: type imports and dynamic imports must not bypass
// the ownership policy just because they use different TypeScript syntax.
it.each([
  "import { read } from '../resolution/index.js';",
  "import type { Read } from '../resolution/index.js';",
  "import { type Read } from '../resolution/index.js';",
  "export type { Read } from '../resolution/index.js';",
  "type Read = import('../resolution/index.js').Read;",
  "const read = () => import('../resolution/index.js');",
])('checks ownership for %s', async (source) => {
  const directory = await mkdtemp(join(tmpdir(), 'relate-boundary-test-'));

  try {
    for (const owner of ['relate', 'protocol', 'runtime', 'postgres', 'node'])
      await mkdir(join(directory, 'packages', owner, 'src'), {
        recursive: true,
      });

    await mkdir(join(directory, 'dev/simulators'), { recursive: true });
    await mkdir(join(directory, 'packages/runtime/src/authorization'), {
      recursive: true,
    });
    await writeFile(
      join(directory, 'packages/runtime/src/authorization/probe.ts'),
      source,
    );
    await expect(
      execFile(
        process.execPath,
        [fileURLToPath(new URL('../boundaries.mjs', import.meta.url))],
        { cwd: directory },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        'Forbidden runtime dependency: authorization/probe.ts -> resolution/index.ts',
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('recognizes Windows paths in ownership and entry-point checks', () => {
  expect(runtimeOwner('actions\\native.ts')).toBe('actions');
  expect(() =>
    assertRuntimeDependency('storage.ts', 'observations\\ordering.ts', false),
  ).not.toThrow();
  expect(() =>
    assertRuntimeDependency(
      'resolution\\source.ts',
      'authorization\\index.ts',
      false,
    ),
  ).not.toThrow();
  expect(() =>
    assertRuntimeDependency(
      'resolution\\source.ts',
      'authorization\\policy.ts',
      true,
    ),
  ).toThrow('Forbidden runtime dependency');
});

it.each([
  ["import type { Acceptance } from '../storage.js';", true],
  ["export type { Acceptance } from '../storage.js';", true],
  ["type Acceptance = import('../storage.js').Acceptance;", true],
  ["import { type Acceptance } from '../storage.js';", false],
  ["export { type Acceptance } from '../storage.js';", false],
  ["import {} from '../storage.js';", false],
  ["export {} from '../storage.js';", false],
])(
  'distinguishes erased edges from module-loading edges: %s',
  async (source, erased) => {
    const directory = await mkdtemp(join(tmpdir(), 'relate-boundary-test-'));
    const run = () =>
      execFile(
        process.execPath,
        [fileURLToPath(new URL('../boundaries.mjs', import.meta.url))],
        { cwd: directory },
      );

    try {
      for (const owner of ['relate', 'protocol', 'runtime', 'postgres', 'node'])
        await mkdir(join(directory, 'packages', owner, 'src'), {
          recursive: true,
        });

      await mkdir(join(directory, 'dev/simulators'), { recursive: true });
      const write = async (file: string, content: string) => {
        const path = join(directory, 'packages/runtime/src', file);

        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      };

      await write('storage.ts', "import './observations/ordering.js';");
      await write('observations/ordering.ts', source);

      if (erased) await expect(run()).resolves.toBeDefined();
      else
        await expect(run()).rejects.toMatchObject({
          stderr: expect.stringContaining('Forbidden runtime dependency'),
        });

      // Same-owner imports bypass ownership checks, but must still enter the
      // execution-cycle graph unless the entire declaration is erased.
      await write('storage.ts', '');
      await write('observations/ordering.ts', '');
      await write('reads/a.ts', source.replace('../storage.js', './b.js'));
      await write('reads/b.ts', "import './a.js';");

      if (erased) await expect(run()).resolves.toBeDefined();
      else
        await expect(run()).rejects.toMatchObject({
          stderr: expect.stringContaining('Execution import cycle'),
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
