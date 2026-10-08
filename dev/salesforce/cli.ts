import { ScratchOrg } from './harness.js';

const org = new ScratchOrg();
const abort = new AbortController();
const stop = () => abort.abort(new Error('Interrupted'));

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  switch (process.argv[2]) {
    case 'create':
      await org.create(abort.signal);
      console.log(
        'Scratch org seeded. Reuse with example:salesforce --existing; delete with salesforce:dev delete.',
      );
      break;
    case 'reset':
      await org.reset();
      console.log('Fixture Accounts reset.');
      break;
    case 'delete':
      await org.destroy();
      console.log('Owned scratch org deleted.');
      break;
    default:
      throw new Error('Usage: pnpm salesforce:dev create|reset|delete');
  }
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Salesforce harness failed',
  );
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
