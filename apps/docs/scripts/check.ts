import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pages, pageFile, pageUrl } from '../lib/pages.js';
import { validateDocumentation } from './validation.js';

const app = fileURLToPath(new URL('../', import.meta.url));
const repository = path.resolve(app, '../..');
const content = path.join(app, 'content');
const output = path.join(app, 'out');

if (!existsSync(output))
  throw new Error('Build the docs before checking links: pnpm docs:build');

const contentFiles = readdirSync(content, { recursive: true })
  .map(String)
  .filter((file) => /\.mdx?$/.test(file));
const html = new Map(
  readdirSync(output, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.html'))
    .map((file) => [file, readFileSync(path.join(output, file), 'utf8')]),
);
const issues = validateDocumentation({
  pages: pages.map((page) => ({ file: pageFile(page), url: pageUrl(page) })),
  contentFiles,
  html,
  repositoryExists: (target) => existsSync(path.join(repository, target)),
  assetExists: (target) =>
    statSync(path.join(output, target), { throwIfNoEntry: false })?.isFile() ??
    false,
});

if (issues.length) {
  console.error(issues.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${pages.length} registered docs pages, generated links and anchors, and repository targets.`,
  );
}
