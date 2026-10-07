import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import {
  assertRuntimeDependency,
  runtimeOwner,
} from './architecture/runtime-boundaries.ts';

const root = process.cwd();
const owners = ['relate', 'protocol', 'runtime', 'postgres', 'node', 'cli'];
const allowed = {
  relate: new Set(['zod', '@relate/protocol']),
  protocol: new Set(),
  runtime: new Set(['relate/model', '@relate/protocol']),
  postgres: new Set(['relate/model', '@relate/runtime/storage', 'pg']),
  node: new Set([
    'relate',
    'relate/compiler',
    '@relate/runtime',
    '@relate/protocol',
  ]),
  // Local processes, files and the inspector host: never runtime or storage.
  cli: new Set([
    'relate',
    'relate/compiler',
    'relate/diagnostics',
    'relate/model',
    '@relate/node',
    '@relate/inspector/protocol',
    '@relate/inspector/server',
    'hono',
    'hono/cookie',
    'hono/streaming',
    '@hono/node-server',
    'esbuild',
    'zod',
  ]),
};
// Browser code in the inspector never reaches the compiler, runtime or Node.
const inspectorBrowserForbidden = new Set([
  'relate',
  'relate/compiler',
  '@relate/node',
  '@relate/runtime',
  '@relate/runtime/storage',
  '@relate/postgres',
  '@relate/cli',
  '@relate/protocol',
]);
const graph = new Map();

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? walk(resolve(directory, entry.name))
          : [resolve(directory, entry.name)],
      ),
    )
  ).flat();
}

for (const owner of owners) {
  const directory = resolve(root, 'packages', owner, 'src');

  for (const file of await walk(directory)) {
    if (!file.endsWith('.ts')) continue;

    if (owner === 'runtime') runtimeOwner(relative(directory, file));

    const parsed = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges = [];

    function visit(node) {
      const literal =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : undefined;
      // With verbatimModuleSyntax, inline type specifiers still emit an empty
      // import/export declaration and load the target module at runtime.
      const typeOnly =
        ts.isImportTypeNode(node) ||
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly);

      // The CLI's application child imports the user's bundle by computed path.
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!literal || !ts.isStringLiteral(literal)) &&
        owner !== 'cli'
      )
        throw new Error(`Nonliteral import cannot be checked: ${file}`);

      if (literal && ts.isStringLiteral(literal)) {
        const name = literal.text;

        if (name.startsWith('.')) {
          const target = resolve(dirname(file), name.replace(/\.js$/, '.ts'));

          if (!target.startsWith(directory + sep))
            throw new Error(`Cross-package relative import: ${file}: ${name}`);

          if (owner === 'runtime')
            assertRuntimeDependency(
              relative(directory, file),
              relative(directory, target),
              Boolean(typeOnly),
            );

          if (!typeOnly) edges.push(target);
        } else if (name.startsWith('node:')) {
          if (!(
            owner === 'postgres' ||
            owner === 'cli' ||
            (owner === 'relate' && file.endsWith(`${sep}compiler.ts`)) ||
            (owner === 'runtime' && name === 'node:crypto')
          ))
            throw new Error(`Platform dependency: ${file}: ${name}`);
        } else if (!allowed[owner].has(name))
          throw new Error(`Forbidden dependency: ${file}: ${name}`);
      }

      ts.forEachChild(node, visit);
    }

    visit(parsed);
    graph.set(file, edges);
  }
}

// Type-only cycles are permitted for contract types; execution cycles are checked separately below.
const visited = new Set(),
  visiting = new Set();

async function check(file) {
  if (visiting.has(file))
    throw new Error(`Execution import cycle: ${relative(root, file)}`);

  if (visited.has(file)) return;

  visiting.add(file);

  for (const target of graph.get(file) ?? []) await check(target);

  visiting.delete(file);
  visited.add(file);
}

for (const file of graph.keys()) await check(file);

// The inspector's browser modules: only server.ts may touch Node.
const inspectorSource = resolve(root, 'apps/inspector/src');

for (const file of await walk(inspectorSource)) {
  if (!/\.tsx?$/.test(file)) continue;

  const serverOnly = file === resolve(inspectorSource, 'server.ts');
  const parsed = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function visitInspector(node) {
    const literal =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0]
          : undefined;

    if (literal && ts.isStringLiteral(literal)) {
      const name = literal.text.replace(/\?.*$/, '');

      if (!serverOnly && name.startsWith('node:'))
        throw new Error(
          `Inspector browser code imports Node: ${file}: ${name}`,
        );

      if (inspectorBrowserForbidden.has(name))
        throw new Error(
          `Inspector imports a forbidden package: ${file}: ${name}`,
        );
    }

    ts.forEachChild(node, visitInspector);
  }

  visitInspector(parsed);
}

// Simulators are provider fixtures; they cannot import Relate or application code.
for (const file of await walk(resolve(root, 'dev/simulators'))) {
  const content = await readFile(file, 'utf8');

  if (
    /from\s+['"](?!node:|hono['"]|@hono\/node-server['"])|import\s*\(/.test(
      content,
    )
  )
    throw new Error(`Simulator dependency: ${file}`);
}

console.log(
  `Verified package/runtime boundaries and execution cycles (${graph.size} modules).`,
);
