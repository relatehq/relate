import { ScratchOrg, withInterrupt } from './harness.js';

const org = new ScratchOrg();

try {
  await withInterrupt(async (signal) => {
    switch (process.argv[2]) {
      case 'create':
        await org.create(signal);
        console.log(
          'Scratch org seeded. Reuse with example:salesforce --existing; delete with salesforce:dev delete.',
        );
        break;
      case 'reset':
        await org.reset(signal);
        console.log('Fixture Accounts reset.');
        break;
      case 'delete':
        await org.destroy(signal);
        console.log('Owned scratch org deleted.');
        break;
      default:
        throw new Error('Usage: pnpm salesforce:dev create|reset|delete');
    }
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Salesforce harness failed',
  );
  process.exitCode = 1;
}
