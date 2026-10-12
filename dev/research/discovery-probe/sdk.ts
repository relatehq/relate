import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Sdk {
  readonly relate: typeof import('relate');
  readonly node: typeof import('@relate/node');
  readonly z: typeof import('zod').z;
}

/**
 * Load the built SDK from a Relate checkout, so one probe can compare SDK
 * versions (for example, main before and after a discovery change). The graph
 * is authored with that checkout's own `relate` and `zod` instances.
 */
export async function loadSdk(checkout: string): Promise<Sdk> {
  const load = (path: string) => import(pathToFileURL(path).href);
  const require = createRequire(join(checkout, 'packages/relate/package.json'));
  const zodPackage = require.resolve('zod/package.json');
  const zodEntry = (
    JSON.parse(readFileSync(zodPackage, 'utf8')) as {
      exports: { '.': { import: string } };
    }
  ).exports['.'].import;

  return {
    relate: await load(join(checkout, 'packages/relate/dist/index.js')),
    node: await load(join(checkout, 'packages/node/dist/index.js')),
    z: (await load(join(dirname(zodPackage), zodEntry))).z,
  };
}
