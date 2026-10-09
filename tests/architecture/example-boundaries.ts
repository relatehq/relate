import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

const generated = new Set([
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.git',
  '.relate',
  '.next',
  '.next-internal',
  '.source',
  '.source-internal',
]);
const isSource = /\.(?:[cm]?[jt]s|[jt]sx)$/;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === 'ENOENT') return [];

      throw error;
    },
  );

  return (
    await Promise.all(
      entries
        .filter((entry) => !generated.has(entry.name))
        .map((entry) => {
          const path = resolve(directory, entry.name);

          return entry.isDirectory()
            ? files(path)
            : isSource.test(path)
              ? [path]
              : [];
        }),
    )
  ).flat();
}

/**
 * Unlike production dependency checks, this rule includes tests and their helpers.
 * Neither `examples/` (learning material) nor `dev/fixtures/` (exploratory design)
 * may serve as setup for packages, apps, connectors or repository tests.
 */
export async function assertNoExampleDependencies(
  root: string,
  workspaces: readonly { name: string; path: string }[],
) {
  const examples = resolve(root, 'examples');
  const insideExamples = (path: string) =>
    path === examples || path.startsWith(examples + sep);
  const fixtures = resolve(root, 'dev/fixtures');
  const insideFixtures = (path: string) =>
    path === fixtures || path.startsWith(fixtures + sep);
  const exampleNames = workspaces
    .filter((workspace) => insideExamples(resolve(workspace.path)))
    .map((workspace) => workspace.name);
  const isExampleName = (name: string) =>
    exampleNames.some(
      (example) => name === example || name.startsWith(example + '/'),
    );
  const configPath = ts.findConfigFile(root, ts.sys.fileExists);
  const options = configPath
    ? ts.parseJsonConfigFileContent(
        ts.readConfigFile(configPath, ts.sys.readFile).config,
        ts.sys,
        root,
      ).options
    : {};
  const directories = [
    ...workspaces
      .filter((workspace) => !insideExamples(resolve(workspace.path)))
      .map((workspace) => workspace.path),
    resolve(root, 'tests'),
  ];

  for (const workspace of workspaces.filter(
    (workspace) => !insideExamples(resolve(workspace.path)),
  )) {
    const manifest = JSON.parse(
      await readFile(resolve(workspace.path, 'package.json'), 'utf8'),
    );

    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, value] of Object.entries(manifest[section] ?? {})) {
        const target =
          typeof value === 'string' && /^(?:file|link):/.test(value)
            ? resolve(workspace.path, value.replace(/^(?:file|link):/, ''))
            : undefined;

        if (isExampleName(name) || (target && insideExamples(target)))
          throw new Error(
            `Forbidden example dependency: ${workspace.path}/package.json: ${name}`,
          );
      }
    }
  }

  for (const file of new Set(
    (await Promise.all(directories.map(files))).flat(),
  )) {
    const ast = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    function visit(node: ts.Node) {
      const literal =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : ts.isExternalModuleReference(node)
              ? node.expression
              : ts.isCallExpression(node) &&
                  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    (ts.isIdentifier(node.expression) &&
                      node.expression.text === 'require'))
                ? node.arguments[0]
                : undefined;

      if (literal && ts.isStringLiteralLike(literal)) {
        const name = literal.text;
        const lexical =
          name.startsWith('.') || name.startsWith('/')
            ? resolve(dirname(file), name)
            : undefined;
        const resolved = ts.resolveModuleName(
          name,
          file,
          { moduleResolution: ts.ModuleResolutionKind.NodeNext, ...options },
          ts.sys,
        ).resolvedModule?.resolvedFileName;

        if (
          isExampleName(name) ||
          (lexical && insideExamples(lexical)) ||
          (resolved && insideExamples(resolve(resolved)))
        )
          throw new Error(
            `Forbidden example dependency: ${relative(root, file)}: ${name}`,
          );

        if (
          (lexical && insideFixtures(lexical)) ||
          (resolved && insideFixtures(resolve(resolved)))
        )
          throw new Error(
            `Forbidden dev fixture dependency: ${relative(root, file)}: ${name}`,
          );
      }

      ts.forEachChild(node, visit);
    }

    visit(ast);
  }
}
