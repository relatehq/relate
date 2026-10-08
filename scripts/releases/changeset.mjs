import { assertReleasesEnabled, run } from './shared.mjs';

await assertReleasesEnabled();
run('pnpm', ['exec', 'changeset', ...process.argv.slice(2)]);
