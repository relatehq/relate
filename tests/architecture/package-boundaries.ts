/** Exact public imports, independent of package.json dependency declarations. */
export const packagePolicies: Record<
  string,
  {
    imports: readonly string[];
    /** Additional imports only for package-local examples, never library source. */
    exampleImports?: readonly string[];
    builtins?: true | readonly string[];
    /** Non-code local imports, such as an app stylesheet. */
    assets?: readonly string[];
  }
> = {
  'connectors/stripe': { imports: ['relate/connectors'] },
  'connectors/salesforce': { imports: ['relate/connectors'] },
  'dev/salesforce': {
    imports: ['@relate/connector-salesforce', 'zod'],
    builtins: true,
  },
  'connectors/postgres': {
    imports: ['relate/connectors', 'relate/analytics', 'pg'],
  },
  'connectors/sqlite': {
    imports: ['relate/connectors', 'relate/analytics'],
    builtins: [
      'node:sqlite',
      'node:worker_threads',
      'node:path',
      'node:child_process',
    ],
  },
  'examples/02-customer-workspace': {
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
  'packages/relate': { imports: ['zod', '@relate/protocol'] },
  'packages/protocol': { imports: [] },
  'packages/sql-parser': { imports: ['relate/analytics', 'libpg-query'] },
  'packages/runtime': {
    imports: [
      'relate/diagnostics',
      'relate/analytics',
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
    // The host hashes physical binding identity before exposing its revision.
    builtins: ['node:crypto'],
    imports: [
      'relate/model',
      'relate/analytics',
      '@relate/sql-parser',
      'relate',
      'relate/compiler',
      'relate/connectors',
      'relate/consumer',
      '@relate/runtime',
      '@relate/protocol',
    ],
  },
  // Browser safe: the typed facade and authoring types, never the engine.
  'packages/client': {
    imports: ['@relate/protocol', 'relate', 'relate/consumer'],
  },
  'packages/http': { imports: ['@relate/runtime', '@relate/protocol'] },
  'packages/mcp': {
    imports: [
      '@relate/protocol',
      'relate/consumer',
      '@modelcontextprotocol/server',
      '@modelcontextprotocol/server/stdio',
      'zod',
    ],
    exampleImports: [
      '@relate/mcp',
      'relate',
      'relate/compiler',
      '@relate/node',
      '@modelcontextprotocol/client',
    ],
    builtins: true,
  },
  'packages/cli': {
    imports: [
      '@relate/dev',
      '@relate/inspector/protocol',
      'relate/model',
      'relate/diagnostics',
    ],
    builtins: true,
  },
  'packages/dev': {
    imports: [
      'relate',
      'relate/compiler',
      'relate/consumer',
      'relate/storage',
      '@relate/node',
      '@relate/protocol',
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
      '@relate/mcp',
      '@modelcontextprotocol/client',
      '@anthropic-ai/sdk',
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
      'typedoc',
      'typedoc-plugin-markdown',
      'fumadocs-core/mdx-plugins',
      'beautiful-mermaid',
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
      '@codemirror/autocomplete',
      '@codemirror/commands',
      '@codemirror/lang-javascript',
      '@codemirror/language',
      '@codemirror/lint',
      '@codemirror/state',
      '@codemirror/view',
      '@lezer/highlight',
      '@base-ui/react/dialog',
      '@base-ui/react/popover',
      '@base-ui/react/select',
      'elkjs/lib/elk-api.js',
      'elkjs/lib/elk-worker.min.js?worker&url',
      'prettier/standalone',
      'prettier/plugins/babel',
      'prettier/plugins/estree',
      'react-markdown',
      'remark-gfm',
      'remend',
      'vite',
      '@vitejs/plugin-react',
      '@fontsource/inter/400.css',
      '@fontsource/inter/500.css',
      '@fontsource/inter/600.css',
      '@fontsource/dm-mono/400.css',
      '@fontsource/dm-mono/500.css',
    ],
  },
  'examples/01-todo-notes': {
    imports: ['relate', '@relate/node', 'zod'],
    builtins: true,
  },
  'dev/simulators/crm': {
    imports: ['hono', '@hono/node-server'],
    builtins: ['node:events', 'node:http'],
  },
  'examples/04-customer-events': {
    imports: [
      'relate',
      'relate/consumer',
      'relate/compiler',
      '@relate/node',
      '@relate/connector-sqlite',
      'zod',
    ],
    builtins: true,
  },
  'examples/03-postgres-persistence': {
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
    'src/consumer.ts',
    'src/model.ts',
    'src/connectors.ts',
    'src/storage.ts',
    'src/analytics.ts',
  ]) {
    const visited = new Set<string>();
    const visit = (file: string, path: readonly string[]): void => {
      if (visited.has(file)) return;

      visited.add(file);
      const compiler =
        file === 'src/compiler.ts' || file.startsWith('src/compiler/');
      const model = file === 'src/model.ts' || file.startsWith('src/model/');
      const analytics =
        file === 'src/analytics.ts' || file.startsWith('src/analytics/');

      if (
        compiler ||
        (['src/connectors.ts', 'src/storage.ts'].includes(entry) &&
          !['src/connectors.ts', 'src/storage.ts'].includes(file) &&
          !analytics) ||
        (entry === 'src/analytics.ts' && !analytics) ||
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

/** file is a normalized path relative to its owning package. */
export function assertPackageImport(
  owner: string,
  file: string,
  name: string,
): void {
  const policy = packagePolicies[owner];

  if (
    !policy?.imports.includes(name) &&
    !(file.startsWith('examples/') && policy?.exampleImports?.includes(name))
  )
    throw new Error(`Forbidden dependency: ${owner}/${file}: ${name}`);
}
