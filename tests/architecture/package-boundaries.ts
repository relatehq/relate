/** Exact public imports, independent of package.json dependency declarations. */
export const packagePolicies: Record<
  string,
  {
    imports: readonly string[];
    builtins?: true | readonly string[];
    /** Non-code local imports, such as an app stylesheet. */
    assets?: readonly string[];
  }
> = {
  'connectors/sqlite': {
    imports: ['relate/connectors'],
    builtins: ['node:sqlite', 'node:worker_threads', 'node:path'],
  },
  'examples/03-customer-workspace': {
    imports: [
      'relate',
      'relate/connectors',
      '@relate/node',
      '@relate/protocol',
      '@relate/connector-sqlite',
      '@relate/dev-crm-simulator',
      'zod',
    ],
    builtins: true,
  },
  'examples/02-customer-accounts': {
    imports: ['relate', '@relate/node', '@relate/connector-sqlite', 'zod'],
    builtins: true,
  },
  'packages/relate': { imports: ['zod', '@relate/protocol'] },
  'packages/protocol': { imports: [] },
  'packages/runtime': {
    imports: [
      'relate/model',
      'relate/connectors',
      'relate/storage',
      '@relate/protocol',
    ],
    builtins: ['node:crypto'],
  },
  'packages/postgres': {
    imports: ['relate/model', '@relate/runtime/storage', 'pg'],
    builtins: true,
  },
  'packages/node': {
    imports: [
      'relate',
      'relate/compiler',
      'relate/connectors',
      '@relate/runtime',
      '@relate/protocol',
    ],
  },
  'packages/client': { imports: ['@relate/protocol'] },
  'packages/http': { imports: ['@relate/runtime', '@relate/protocol'] },
  'packages/mcp': { imports: ['@relate/runtime', '@relate/protocol'] },
  'packages/cli': {
    imports: [
      'relate',
      'relate/compiler',
      '@relate/node',
      '@relate/runtime',
      '@relate/postgres',
      'relate/diagnostics',
      'relate/model',
      '@relate/inspector/protocol',
      '@relate/inspector/server',
      'hono',
      'hono/cookie',
      'hono/streaming',
      '@hono/node-server',
      'esbuild',
      'zod',
    ],
    builtins: true,
  },
  'packages/create-relate': { imports: [], builtins: true },
  'apps/docs': {
    assets: ['app/global.css'],
    imports: [
      'next',
      'next/navigation',
      'react',
      '@fumadocs/mdx-remote',
      'fumadocs-ui/provider/next',
      'fumadocs-ui/layouts/docs',
      'fumadocs-ui/layouts/docs/page',
      'fumadocs-ui/mdx',
      'rehype-raw',
    ],
    builtins: true,
  },
  'apps/www': { imports: [] },
  'apps/inspector': {
    imports: [
      '@relate/client',
      'relate/model',
      'relate/diagnostics',
      'zod',
      'hono',
      'react',
      'react-dom/client',
      '@tanstack/react-query',
      '@tanstack/react-router',
      '@xyflow/react',
      '@xyflow/react/dist/style.css',
      'elkjs/lib/elk-api.js',
      'elkjs/lib/elk-worker.min.js?worker&url',
      'vite',
      '@vitejs/plugin-react',
      '@fontsource/inter/400.css',
      '@fontsource/inter/500.css',
      '@fontsource/inter/600.css',
      '@fontsource/dm-mono/400.css',
      '@fontsource/dm-mono/500.css',
    ],
  },
  'examples/01-hello-world': {
    imports: ['relate', '@relate/node', 'zod'],
    builtins: true,
  },
  'dev/simulators/crm': {
    imports: ['hono', '@hono/node-server'],
    builtins: ['node:events', 'node:http'],
  },
  'examples/04-postgres-persistence': {
    imports: [
      'relate',
      'relate/compiler',
      'relate/connectors',
      '@relate/runtime',
      '@relate/postgres',
      '@relate/dev-crm-simulator',
      'zod',
    ],
    builtins: true,
  },
};

/** Follow type edges as well: portable declarations must not depend on the compiler. */
export function assertRelateEntryPoints(
  graph: ReadonlyMap<string, readonly string[]>,
): void {
  for (const entry of [
    'src/index.ts',
    'src/model.ts',
    'src/connectors.ts',
    'src/storage.ts',
  ]) {
    const visited = new Set<string>();
    const visit = (file: string, path: readonly string[]): void => {
      if (visited.has(file)) return;

      visited.add(file);
      const compiler =
        file === 'src/compiler.ts' || file.startsWith('src/compiler/');
      const model = file === 'src/model.ts' || file.startsWith('src/model/');

      if (
        compiler ||
        (['src/connectors.ts', 'src/storage.ts'].includes(entry) &&
          !['src/connectors.ts', 'src/storage.ts'].includes(file)) ||
        (entry === 'src/model.ts' && !model && file !== 'src/diagnostics.ts')
      )
        throw new Error(
          `Forbidden relate entry-point dependency: ${[...path, file].join(' -> ')}`,
        );

      for (const target of graph.get(file) ?? [])
        visit(target, [...path, file]);
    };

    if (graph.has(entry)) visit(entry, []);
  }
}
