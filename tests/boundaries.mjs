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
const relateGraph = new Map();
const source = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  'out',
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
      (file) =>
        source.test(file) &&
        !file.endsWith('/next-env.d.ts') &&
        !/\.(?:test|spec)\.[^.]+$/.test(file),
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

      // The CLI's application child imports the user's bundle by computed path.
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require')) &&
        (!literal || !ts.isStringLiteral(literal)) &&
        !(
          owner === 'packages/cli' &&
          relative(directory, file) === `src${sep}dev${sep}worker.ts` &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        )
      )
        throw new Error(`Nonliteral import cannot be checked: ${file}`);

      if (literal && ts.isStringLiteral(literal)) {
        const name = literal.text;

        if (name.startsWith('.')) {
          // The published executable loads the emitted counterpart of src/bin.ts.
          if (
            owner === 'packages/cli' &&
            relative(directory, file) === `bin${sep}relate.js` &&
            name === '../dist/bin.js'
          ) {
            const entry = resolve(directory, 'src/bin.ts');

            if (!files.has(entry))
              throw new Error(`Missing CLI source entry: ${entry}`);

            edges.push(entry);
            allEdges.push('src/bin.ts');

            return;
          }

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

          // Check the lexical path even when TypeScript cannot resolve it.
          if (!resolve(dirname(file), name).startsWith(directory + sep))
            throw new Error(`Cross-package relative import: ${file}: ${name}`);

          if (owner === 'apps/inspector' && name.endsWith('.css')) return;

          const localPath = resolve(dirname(file), name);

          if (
            policy.assets?.includes(
              relative(directory, localPath).replaceAll(sep, '/'),
            ) &&
            ts.sys.fileExists(localPath) &&
            !source.test(localPath)
          )
            return;

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
            (owner === 'apps/inspector' &&
              relative(directory, file) === `src${sep}server.ts`) ||
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

// The inspector's browser modules: only server.ts may touch Node.
const inspectorSource = resolve(root, 'apps/inspector/src');

for (const file of await walk(inspectorSource).catch((error) => {
  if (error.code === 'ENOENT') return [];

  throw error;
})) {
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
  `Verified package/runtime boundaries and execution cycles (${workspaces.length} packages, ${graph.size} modules).`,
);
