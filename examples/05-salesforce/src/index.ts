import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { startApp } from '@relate/node';
import { salesforce } from '@relate/connector-salesforce';
import {
  ScratchOrg,
  withInterrupt,
  withScratchOrg,
} from '@relate/dev-salesforce/harness';
import { customerApp } from './model.js';

async function explore(org: ScratchOrg, signal: AbortSignal) {
  const info = await org.info();
  let credentials = await org.credentials();
  const connector = salesforce({
    credentials: () => credentials,
    apiVersion: '67.0',
    timeoutMs: 30_000,
  }).resource('Account', { fields: ['Name', 'Website'] });
  const providerAccountId = await connector.identify({ signal });
  const model = customerApp(connector, providerAccountId);
  const app = await startApp(model.app);
  const terminal = createInterface({ input: stdin, output: stdout });

  try {
    const ids = await Promise.all(
      info.accountIds.map((id) => app.host.adopt(model.Customer, id)),
    );
    const customers = app.as(model.employee).objects.Customer;

    do {
      for (const id of ids)
        console.log(
          JSON.stringify(
            await customers.get(id, {
              select: ['name', 'website'],
              refresh: true,
            }),
            null,
            2,
          ),
        );

      if (!stdin.isTTY || process.argv.includes('--once')) break;

      const input = await terminal.question(
        'Enter to refresh Salesforce, or q to quit: ',
        { signal },
      );

      if (input.trim() === 'q') break;

      // Resolve CLI credentials outside Relate's short per-read deadline.
      credentials = await org.credentials();
      signal.throwIfAborted();
    } while (!signal.aborted);
  } finally {
    terminal.close();
    await app.close();
  }
}

try {
  if (process.argv.includes('--existing'))
    await withInterrupt((signal) => explore(new ScratchOrg(), signal));
  else await withScratchOrg(explore);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Salesforce example failed',
  );
  process.exitCode = 1;
}
