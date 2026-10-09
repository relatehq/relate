import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application, Converter } from 'typedoc';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(appDirectory, '../..');
const output = path.join(appDirectory, 'content/reference/api');
// Keep the preview small. Only these public exports receive reference pages.
const selected = ['defineSource', 'ObjectId', 'ReadOptions', 'QueryOptions'];
const app = await Application.bootstrapWithPlugins({
  entryPoints: [path.join(repository, 'packages/relate/src/index.ts')],
  tsconfig: path.join(appDirectory, 'tsconfig.reference.json'),
  plugin: ['typedoc-plugin-markdown'],
  name: 'API Reference',
  outputs: [{ name: 'markdown', path: output }],
  readme: 'none',
  hidePageHeader: true,
  hideBreadcrumbs: true,
  useCodeBlocks: true,
  expandObjects: true,
  sourceLinkTemplate:
    'https://github.com/relatehq/relate/blob/main/{path}#L{line}',
  parametersFormat: 'table',
  propertiesFormat: 'table',
  entryFileName: 'index',
  gitRevision: 'main',
});

// Filter before TypeDoc builds groups and navigation, not just output files.
app.converter.on(Converter.EVENT_RESOLVE_BEGIN, ({ project }) => {
  for (const name of selected) {
    if (!project.children?.some((child) => child.name === name))
      throw new Error(`Missing public export: ${name}`);
  }

  for (const child of [...(project.children ?? [])]) {
    if (!selected.includes(child.name)) project.removeReflection(child);
  }
});
const project = await app.convert();

if (!project) throw new Error('TypeDoc could not convert the public API.');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await app.generateOutputs(project);

if (app.logger.hasErrors()) throw new Error('Reference generation failed.');

const pages = [];
const files = (await readdir(output, { recursive: true })).sort((a, b) =>
  a === 'index.md' ? -1 : b === 'index.md' ? 1 : a.localeCompare(b),
);

for (const file of files) {
  if (!file.endsWith('.md')) continue;

  const source = await readFile(path.join(output, file), 'utf8');
  const title =
    source.match(/^# (.+)$/m)?.[1]?.replace(/\\/g, '') ?? 'API Reference';

  pages.push({
    slug: ['reference', 'api', ...file.slice(0, -3).split(path.sep)],
    name: file === 'index.md' ? 'API Reference' : path.basename(file, '.md'),
    title,
    description:
      'API reference generated from Relate types and documentation comments.',
    section: 'API Reference',
  });
}

await writeFile(
  path.join(appDirectory, 'lib/generated-reference.json'),
  JSON.stringify(pages, null, 2) + '\n',
);
console.log(
  `Generated ${pages.length} reference pages from ${selected.length} public exports.`,
);
