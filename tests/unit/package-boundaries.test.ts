import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { initializeBoundaryWorkspace } from '../support/boundary-workspace.js';

const execFile = promisify(callback);

async function check(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), 'relate-package-boundaries-'));

  try {
    await initializeBoundaryWorkspace(directory);

    for (const [name, content] of Object.entries(files)) {
      const file = join(directory, name);

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }

    return await execFile(
      process.execPath,
      [fileURLToPath(new URL('../boundaries.mjs', import.meta.url))],
      { cwd: directory },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const compiler = {
  'packages/relate/src/compiler.ts':
    "import 'node:crypto'; export function compile() {}",
};

it.each(['connectors', 'storage'])(
  'keeps %s contracts independent of graph authoring, including type imports',
  async (entry) => {
    await expect(
      check({
        'packages/relate/src/index.ts': 'export interface GraphDefinition {}',
        [`packages/relate/src/${entry}.ts`]:
          "import type { GraphDefinition } from './index.js';",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(`src/${entry}.ts -> src/index.ts`),
    });
  },
);

it.each([
  "export { compile } from './compiler.js';",
  "export * from './compiler.js';",
  "const load = () => import('./compiler.js');",
  "type Compiler = typeof import('./compiler.js');",
])('rejects authoring dependencies on the compiler: %s', async (source) => {
  await expect(
    check({ ...compiler, 'packages/relate/src/index.ts': source }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      'Forbidden relate entry-point dependency: src/index.ts -> src/compiler.ts',
    ),
  });
});

it('reports the full transitive path through an authoring helper', async () => {
  await expect(
    check({
      ...compiler,
      'packages/relate/src/index.ts': "export * from './helper.js';",
      'packages/relate/src/helper.ts':
        "export { compile } from './compiler.js';",
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      'src/index.ts -> src/helper.ts -> src/compiler.ts',
    ),
  });
});

it.each(['index.ts', 'actions.ts', 'compiler.ts'])(
  'keeps model independent of %s through a model helper',
  async (target) => {
    await expect(
      check({
        [`packages/relate/src/${target}`]: 'export {};',
        'packages/relate/src/model.ts':
          "export * from './model/validation.js';",
        'packages/relate/src/model/validation.ts': `import '../${target.replace('.ts', '.js')}';`,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `src/model.ts -> src/model/validation.ts -> src/${target}`,
      ),
    });
  },
);

it('allows separate compiler, portable authoring and model helper entry points', async () => {
  await expect(
    check({
      ...compiler,
      'packages/relate/src/index.ts': "export * from './actions.js';",
      'packages/relate/src/actions.ts':
        "import type { Manifest } from './model.js';",
      'packages/relate/src/model.ts': "export * from './model/validation.js';",
      'packages/relate/src/model/validation.ts':
        "import { z } from 'zod'; export type Manifest = unknown;",
    }),
  ).resolves.toBeDefined();
});

it.each([
  ['packages/new-package', '@relate/new-package'],
  ['connectors/crm', '@relate/connector-crm'],
  ['apps/new-app', '@relate/new-app'],
  ['examples/new-example', '@relate/new-example'],
])(
  'requires a policy even for a source-free new workspace %s',
  async (path, name) => {
    await expect(
      check({ [`${path}/package.json`]: JSON.stringify({ name }) }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `Workspace package has no boundary policy: ${path}`,
      ),
    });
  },
);

it('uses pnpm workspace patterns rather than a fixed list of directory roots', async () => {
  await expect(
    check({
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n  - tools/*\n',
      'tools/new-tool/package.json': JSON.stringify({ name: '@relate/tool' }),
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      'Workspace package has no boundary policy: tools/new-tool',
    ),
  });
});

it.each([
  ['src/index.ts', "import 'node:fs';", 'Platform dependency'],
  ['src/index.tsx', "import 'fs';", 'Platform dependency'],
  ['index.mjs', "import 'node:fs/promises';", 'Platform dependency'],
  ['src/index.cjs', "require('node:fs');", 'Platform dependency'],
  ['src/index.ts', "import '@relate/runtime';", 'Forbidden dependency'],
  [
    'src/index.ts',
    "type Engine = typeof import('@relate/runtime');",
    'Forbidden dependency',
  ],
  ['src/index.ts', "import 'relate/compiler';", 'Forbidden dependency'],
])('checks browser-client source %s: %s', async (file, source, error) => {
  await expect(
    check({
      'packages/client/package.json': JSON.stringify({
        name: '@relate/client',
      }),
      [`packages/client/${file}`]: source,
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining(error) });
});

it('accepts declared scaffold policies and portable client imports', async () => {
  await expect(
    check({
      'packages/client/package.json': JSON.stringify({
        name: '@relate/client',
      }),
      'packages/client/src/index.ts':
        "export type { ReadResult } from '@relate/protocol';",
      'apps/inspector/package.json': JSON.stringify({
        name: '@relate/inspector',
      }),
      'apps/inspector/src/index.tsx': "import '@relate/client';",
      'packages/http/package.json': JSON.stringify({ name: '@relate/http' }),
    }),
  ).resolves.toBeDefined();
});

it('does not let production imports escape through excluded test files', async () => {
  await expect(
    check({
      'packages/relate/src/index.ts': "export * from '../test/helper.js';",
      'packages/relate/test/helper.ts': "export * from '../src/compiler.js';",
      ...compiler,
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Unscanned relative import'),
  });
});

it('allows the Postgres example to import the simulator package', async () => {
  await expect(
    check({
      'examples/postgres-persistence/package.json': JSON.stringify({
        name: '@relate/example-postgres-persistence',
      }),
      'examples/postgres-persistence/src/index.ts':
        "import '@relate/dev-crm-simulator';",
      'dev/simulators/crm/package.json': JSON.stringify({
        name: '@relate/dev-crm-simulator',
        private: true,
      }),
      'dev/simulators/crm/index.ts': "import { Hono } from 'hono';",
    }),
  ).resolves.toBeDefined();
});

it('does not allow the example to import package internals', async () => {
  await expect(
    check({
      'examples/postgres-persistence/package.json': JSON.stringify({
        name: '@relate/example-postgres-persistence',
      }),
      'examples/postgres-persistence/src/index.ts':
        "import '../../../packages/runtime/src/runtime.js';",
      'packages/runtime/src/runtime.ts': 'export {};',
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Cross-package relative import'),
  });
});

it('checks browser application source outside src', async () => {
  await expect(
    check({
      'apps/inspector/package.json': JSON.stringify({
        name: '@relate/inspector',
      }),
      'apps/inspector/app/page.tsx': "import '@relate/postgres';",
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Forbidden dependency'),
  });
});

it.each(['node:fs', 'fs'])(
  'rejects inspector browser imports of %s',
  async (builtin) => {
    await expect(
      check({
        'apps/inspector/package.json': JSON.stringify({
          name: '@relate/inspector',
        }),
        'apps/inspector/src/browser.ts': `import '${builtin}';`,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Platform dependency'),
    });
  },
);

it('permits Node only in the inspector asset server and retains CLI entry scanning', async () => {
  await expect(
    check({
      'apps/inspector/package.json': JSON.stringify({
        name: '@relate/inspector',
      }),
      'apps/inspector/src/server.ts': "import 'node:fs';",
      'packages/cli/package.json': JSON.stringify({ name: '@relate/cli' }),
      'packages/cli/bin/relate.js': "import '../dist/bin.js';",
      'packages/cli/src/bin.ts': "import 'node:process';",
    }),
  ).resolves.toBeDefined();
});

it('allows only the docs stylesheet and excludes generated Next.js output', async () => {
  await expect(
    check({
      'apps/docs/package.json': JSON.stringify({ name: '@relate/docs' }),
      'apps/docs/app/layout.tsx': "import './global.css';",
      'apps/docs/app/global.css': "@import 'tailwindcss';",
      'apps/docs/next-env.d.ts': "import './.next/types/routes.d.ts';",
      'apps/docs/out/generated.js': "import 'generated-only';",
    }),
  ).resolves.toBeDefined();
});

it.each(['missing.css', 'other.css', '../out/generated.js'])(
  'rejects undeclared or generated docs imports: %s',
  async (target) => {
    await expect(
      check({
        'apps/docs/package.json': JSON.stringify({ name: '@relate/docs' }),
        'apps/docs/app/layout.tsx': `import './${target}';`,
        'apps/docs/app/other.css': 'body {}',
        'apps/docs/out/generated.js': 'export {};',
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('Unscanned relative import'),
    });
  },
);

it('keeps the CRM simulator independent of Relate', async () => {
  await expect(
    check({
      'dev/simulators/crm/package.json': JSON.stringify({
        name: '@relate/dev-crm-simulator',
        private: true,
      }),
      'dev/simulators/crm/index.ts': "import 'relate';",
    }),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining('Forbidden dependency'),
  });
});
