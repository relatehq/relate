import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const here = fileURLToPath(new URL('..', import.meta.url));
const checkout = resolve(process.argv[2] ?? resolve(here, '../..'));
const requireLocal = createRequire(resolve(here, 'package.json'));
const out = resolve(here, '.local/prepared');

await mkdir(out, { recursive: true });
const names = [
  'relate',
  'relate/compiler',
  'relate/consumer',
  '@relate/node',
  'zod',
];
const resolved = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1).map(n => import.meta.resolve(n))))',
      ...names,
    ],
    { cwd: checkout, encoding: 'utf8' },
  ),
);
const aliases = Object.fromEntries(
  names.map((name, i) => [name, fileURLToPath(resolved[i])]),
);
const hashes = {};

for (const name of ['world', 'worker']) {
  const result = await build({
    entryPoints: [resolve(here, `environment/${name}.mjs`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: resolve(out, `${name}.mjs`),
    metafile: true,
    plugins: [
      {
        name: 'public-sdk',
        setup(b) {
          b.onResolve(
            { filter: /^(relate(?:\/.*)?|@relate\/node|zod|typescript)$/ },
            (args) => {
              const path =
                args.path === 'typescript'
                  ? requireLocal.resolve('typescript')
                  : aliases[args.path];

              return path ? { path } : undefined;
            },
          );
        },
      },
    ],
    banner: {
      js: "import { createRequire as _require } from 'node:module'; const require = _require(import.meta.url); const __filename = require('node:url').fileURLToPath(import.meta.url); const __dirname = require('node:url').fileURLToPath(new URL('.', import.meta.url));",
    },
  });

  for (const path of Object.keys(result.metafile.inputs))
    hashes[resolve(path)] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
}

await cp(resolve(here, 'environment/Dockerfile'), resolve(out, 'Dockerfile'));
const git = (args) =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim();
const manifest = {
  schemaVersion: 1,
  sdkCommit: git(['rev-parse', 'HEAD']),
  sdkDirty: Boolean(
    git(['status', '--porcelain', '--', 'packages', 'connectors']),
  ),
  node: process.version,
  inputs: hashes,
  workerSha256: createHash('sha256')
    .update(await readFile(resolve(out, 'worker.mjs')))
    .digest('hex'),
  worldSha256: createHash('sha256')
    .update(await readFile(resolve(out, 'world.mjs')))
    .digest('hex'),
};

await writeFile(
  resolve(out, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `Prepared public SDK bundles from ${checkout} (${manifest.sdkCommit}).`,
);
