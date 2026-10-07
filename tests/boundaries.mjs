import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import {
  assertRuntimeDependency,
  runtimeOwner,
} from './architecture/runtime-boundaries.ts';

const root = process.cwd();
const owners = ['relate', 'protocol', 'runtime', 'postgres', 'node'];
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
};
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

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!literal || !ts.isStringLiteral(literal))
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
