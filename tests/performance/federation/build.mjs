import { execFileSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const start = performance.now();

execFileSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    `${root}rust/Cargo.toml`,
  ],
  { stdio: 'inherit' },
);
const suffix =
  process.platform === 'darwin'
    ? 'dylib'
    : process.platform === 'win32'
      ? 'dll'
      : 'so';
const prefix = process.platform === 'win32' ? '' : 'lib';

copyFileSync(
  `${root}rust/target/release/${prefix}relate_federation_neon.${suffix}`,
  `${root}engine.node`,
);
console.log(
  JSON.stringify({
    buildMs: performance.now() - start,
    platform: process.platform,
    arch: process.arch,
  }),
);
