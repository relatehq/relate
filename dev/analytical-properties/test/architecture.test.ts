import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps parser and driver imports behind their proposed module seams', () => {
  const allowed: Record<string, string[]> = {
    contracts: [],
    api: ['relate', 'relate/consumer', './contracts.js'],
    values: ['./contracts.js'],
    parser: ['libpg-query', './contracts.js'],
    resolve: ['./values.js', './contracts.js'],
    generate: ['./values.js', './contracts.js'],
    queue: ['./contracts.js'],
    runtime: ['./contracts.js', './resolve.js', './values.js', './queue.js'],
    backends: ['node:child_process', 'pg', './generate.js', './contracts.js'],
  };

  for (const [name, imports] of Object.entries(allowed)) {
    const source = readFileSync(
      new URL(`../${name}.ts`, import.meta.url),
      'utf8',
    );
    const parsed = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
          expect(imports, name).toContain(node.moduleSpecifier.text);
      }

      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        throw new Error(
          `${name}: dynamic import is outside this spike's seams`,
        );

      ts.forEachChild(node, visit);
    }

    visit(parsed);
  }
});
