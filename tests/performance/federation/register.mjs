// Explicit test-process injection; never loaded by a shipped package. Keep the
// real public query orchestration, replacing only its pre-batching computation.
import { registerHooks } from 'node:module';

const target = new URL(
  '../../../packages/runtime/dist/analytical-reads/read.js',
  import.meta.url,
).href;
const executor = new URL('./scope-executor.mjs', import.meta.url).href;
let installed = false;

registerHooks({
  load(url, context, next) {
    const result = next(url, context);

    if (url !== target) return result;

    const source = String(result.source);
    const marker = 'const computed = await computeFields({';

    if (source.split(marker).length !== 2)
      throw new Error(
        'Federation spike injection no longer matches the built runtime',
      );

    installed = true;

    return {
      ...result,
      source: `import { computeScope } from '${executor}';\n${source.replace(marker, 'const computed = await computeScope(computeFields, {')}`,
    };
  },
});

export function assertInstalled() {
  if (!installed)
    throw new Error(
      'Run with --import ./tests/performance/federation/register.mjs before the benchmark entrypoint',
    );
}
