import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createInspectorApp,
  immutableCacheControl,
  normalizeBasePath,
  packagedAssetsDirectory,
} from '../src/server.js';

let assets: string;

beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), 'relate-inspector-assets-'));
  await mkdir(join(assets, 'assets'));
  await writeFile(
    join(assets, 'index.html'),
    '<!doctype html><title>x</title>',
  );
  await writeFile(join(assets, 'assets', 'index-abc123.js'), 'console.log(1)');
  await writeFile(join(assets, 'secret.txt'), 'outside assets');
});

afterAll(async () => {
  await rm(assets, { recursive: true, force: true });
});

it('serves the shell with no-cache and a restrictive policy at the root mount', async () => {
  const { app, verify } = createInspectorApp({ assetsDirectory: assets });

  await verify();
  const shell = await app.request('http://127.0.0.1/');

  expect(shell.status).toBe(200);
  expect(shell.headers.get('cache-control')).toBe('no-cache');
  expect(shell.headers.get('referrer-policy')).toBe('no-referrer');
  expect(shell.headers.get('content-security-policy')).toContain(
    "default-src 'none'",
  );
  expect(shell.headers.get('content-security-policy')).toContain(
    "frame-ancestors 'none'",
  );
  expect(await shell.text()).toContain('<title>x</title>');
  expect((await app.request('http://127.0.0.1/index.html')).status).toBe(308);
});

it('serves hashed assets immutably and returns 404 instead of the SPA for anything else', async () => {
  const { app } = createInspectorApp({ assetsDirectory: assets });
  const asset = await app.request('http://127.0.0.1/assets/index-abc123.js');

  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toBe(immutableCacheControl);
  expect(asset.headers.get('content-type')).toContain('text/javascript');

  for (const path of [
    '/assets/missing.js',
    '/assets/../secret.txt',
    '/assets/..%2Fsecret.txt',
    '/graph',
    '/assets/',
  ]) {
    const response = await app.request(`http://127.0.0.1${path}`);

    expect(response.status, path).toBe(404);
    expect(await response.text(), path).not.toContain('<title>');
  }
});

it('serves under a nested base path and redirects the bare mount', async () => {
  const { app, basePath } = createInspectorApp({
    assetsDirectory: assets,
    basePath: '/tools/inspector/',
  });

  expect(basePath).toBe('/tools/inspector');
  const bare = await app.request('http://127.0.0.1/tools/inspector');

  expect(bare.status).toBe(308);
  expect(bare.headers.get('location')).toBe('/tools/inspector/');
  expect((await app.request('http://127.0.0.1/tools/inspector/')).status).toBe(
    200,
  );
  expect(
    (
      await app.request(
        'http://127.0.0.1/tools/inspector/assets/index-abc123.js',
      )
    ).status,
  ).toBe(200);
  expect(
    (await app.request('http://127.0.0.1/assets/index-abc123.js')).status,
  ).toBe(404);
  expect((await app.request('http://127.0.0.1/tools/inspector/x')).status).toBe(
    404,
  );
  expect(() => normalizeBasePath('tools')).toThrow(/start with/);
  expect(normalizeBasePath('/')).toBe('');
});

it('reports missing packaged assets instead of serving an empty shell', async () => {
  const missing = createInspectorApp({ assetsDirectory: join(assets, 'nope') });

  await expect(missing.verify()).rejects.toThrow(/build @relate\/inspector/);
  expect(packagedAssetsDirectory()).toMatch(/[/\\]client$/);
});
