import assert from 'node:assert/strict';
import { test } from 'vitest';
import { validateDocumentation } from '../scripts/validation.js';

test('detects an unregistered guide even when the remaining site builds', () => {
  const issues = validateDocumentation({
    pages: [{ file: 'index.md', url: '/' }],
    contentFiles: ['index.md', 'runtime/discovery.md'],
    html: new Map([['index.html', '<h1>Home</h1>']]),
    repositoryExists: () => false,
    assetExists: () => false,
  });

  assert.deepEqual(issues, ['Unregistered content: runtime/discovery.md']);
});

test('reports missing registered source and exported pages', () => {
  const issues = validateDocumentation({
    pages: [{ file: 'missing.md', url: '/missing' }],
    contentFiles: [],
    html: new Map(),
    repositoryExists: () => false,
    assetExists: () => false,
  });

  assert.deepEqual(issues, [
    'Missing content: missing.md',
    'Missing exported page: /missing',
  ]);
});

test('checks generated anchors, routes, and rewritten repository links', () => {
  const issues = validateDocumentation({
    pages: [
      { file: 'index.md', url: '/' },
      { file: 'guide.md', url: '/guide' },
    ],
    contentFiles: ['index.md', 'guide.md'],
    html: new Map([
      [
        'index.html',
        '<a href="/guide#gone">Guide</a><a href="/missing">Missing</a><a href="https://github.com/relatehq/relate/blob/main/gone.ts">Source</a>',
      ],
      ['guide.html', '<h2 id="exists">Exists</h2>'],
    ]),
    repositoryExists: () => false,
    assetExists: () => false,
  });

  assert.deepEqual(issues, [
    '/: missing anchor /guide#gone',
    '/: missing target /missing',
    '/: missing repository target https://github.com/relatehq/relate/blob/main/gone.ts',
  ]);
});

test('accepts relative links, encoded anchors, assets, and external URLs', () => {
  const issues = validateDocumentation({
    pages: [
      { file: 'runtime/a.md', url: '/runtime/a' },
      { file: 'runtime/b.md', url: '/runtime/b' },
    ],
    contentFiles: ['runtime/a.md', 'runtime/b.md'],
    html: new Map([
      [
        'runtime/a.html',
        '<a href="b?x=1&amp;y=2#reads-%26-writes">Next</a><a href="/asset.svg">Asset</a><a href="https://example.com/unknown">External</a><a href="https://github.com/relatehq/relate/blob/main/README.md#intro">Readme</a>',
      ],
      [
        'runtime/b.html',
        '<h2 id="reads-&amp;-writes">Reads</h2><a href="#reads-%26-writes">Self</a>',
      ],
    ]),
    repositoryExists: (target) => target === 'README.md',
    assetExists: (target) => target === 'asset.svg',
  });

  assert.deepEqual(issues, []);
});
