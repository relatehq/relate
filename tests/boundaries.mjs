import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { builtinModules } from 'node:module';
import { execFileSync } from 'node:child_process';
import {
  assertRuntimeDependency,
  runtimeOwner,
} from './architecture/runtime-boundaries.ts';
import {
  assertRelateEntryPoints,
  packagePolicies,
} from './architecture/package-boundaries.ts';

const root = process.cwd();
// Ask pnpm to expand its actual workspace configuration, including future roots
// and exclusions. Do not maintain a second list of packages to scan.
const workspaces = JSON.parse(
  execFileSync('pnpm', ['list', '-r', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
  }),
).filter((workspace) => resolve(workspace.path) !== root);
const graph = new Map();
const relateGraph = new Map();
const source = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  'coverage',
  'test',
  'tests',
  '__tests__',
  '.git',
  '.next',
  '.next-internal',
  '.source',
  '.source-internal',
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  return (
    await Promise.all(
      entries
        .filter(
          (entry) =>
            !entry.isDirectory() || !excludedDirectories.has(entry.name),
        )
        .map((entry) =>
          entry.isDirectory()
            ? walk(resolve(directory, entry.name))
            : [resolve(directory, entry.name)],
        ),
    )
  ).flat();
}

for (const workspace of workspaces) {
  const directory = resolve(workspace.path);
  const owner = relative(root, directory).replaceAll(sep, '/');
  const policy = Object.hasOwn(packagePolicies, owner)
    ? packagePolicies[owner]
    : undefined;

  if (!policy)
    throw new Error(
      `Workspace package has no boundary policy: ${owner} (${workspace.name})`,
    );

  const files = new Set(
    (await walk(directory)).filter(
      (file) => source.test(file) && !/\.(?:test|spec)\.[^.]+$/.test(file),
    ),
  );

  for (const file of files) {
    const sourcePath = (path) => relative(resolve(directory, 'src'), path);

    if (owner === 'packages/runtime') runtimeOwner(sourcePath(file));

    const parsed = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const edges = [];
    const allEdges = [];

    function visit(node) {
      const literal =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) &&
                  node.expression.text === 'require'))
            ? node.arguments[0]
            : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
              ? node.argument.literal
              : ts.isExternalModuleReference(node)
                ? node.expression
                : undefined;
      // With verbatimModuleSyntax, inline type specifiers still emit an empty
      // import/export declaration and load the target module at runtime.
      const typeOnly =
        ts.isImportTypeNode(node) ||
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly);

      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')) &&
        (!literal || !ts.isStringLiteral(literal))
      )
        throw new Error(`Nonliteral import cannot be checked: ${file}`);

      if (literal && ts.isStringLiteral(literal)) {
        const name = literal.text;

        if (name.startsWith('.')) {
          const target = ts.resolveModuleName(
            name,
            file,
            {
              module: ts.ModuleKind.NodeNext,
              moduleResolution: ts.ModuleResolutionKind.NodeNext,
              allowJs: true,
              resolveJsonModule: true,
            },
            ts.sys,
          ).resolvedModule?.resolvedFileName;

          // This example uses the independently checked provider simulator.
          // All other cross-package relative imports still fail.
          if (
            target &&
            policy.fixtures?.includes(
              relative(root, target).replaceAll(sep, '/'),
            )
          )
            return;

          // Check the lexical path even when TypeScript cannot resolve it.
          if (!resolve(dirname(file), name).startsWith(directory + sep))
            throw new Error(`Cross-package relative import: ${file}: ${name}`);

          if (owner === 'packages/runtime')
            assertRuntimeDependency(
              sourcePath(file),
              sourcePath(
                target ?? resolve(dirname(file), name.replace(/\.js$/, '.ts')),
              ),
              Boolean(typeOnly),
            );

          if (
            !target ||
            !target.startsWith(directory + sep) ||
            (!files.has(target) && !target.endsWith('.json'))
          )
            throw new Error(`Unscanned relative import: ${file}: ${name}`);

          if (files.has(target)) {
            allEdges.push(relative(directory, target).replaceAll(sep, '/'));

            if (!typeOnly) edges.push(target);
          }
        } else if (name.startsWith('node:') || builtinModules.includes(name)) {
          const builtin = name.startsWith('node:') ? name : `node:${name}`;
          const compiler =
            owner === 'packages/relate' &&
            relative(directory, file) === `src${sep}compiler.ts`;

          if (!(
            compiler ||
            policy.builtins === true ||
            policy.builtins?.includes(builtin)
          ))
            throw new Error(`Platform dependency: ${file}: ${name}`);
        } else if (!policy.imports.includes(name))
          throw new Error(`Forbidden dependency: ${file}: ${name}`);
      }

      ts.forEachChild(node, visit);
    }

    visit(parsed);
    graph.set(file, edges);

    if (owner === 'packages/relate')
      relateGraph.set(relative(directory, file).replaceAll(sep, '/'), allEdges);
  }
}

assertRelateEntryPoints(relateGraph);

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
  `Verified package/runtime boundaries and execution cycles (${workspaces.length} packages, ${graph.size} modules).`,
);
