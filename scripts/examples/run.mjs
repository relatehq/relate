import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runCommand } from './process.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const examples = {
  'hello-world': { directory: '01-hello-world', projects: ['packages/node'] },
  'customer-accounts': {
    directory: '02-customer-accounts',
    projects: ['packages/node', 'connectors/sqlite'],
  },
  'customer-workspace': {
    directory: '03-customer-workspace',
    projects: ['packages/cli', 'connectors/sqlite'],
    client: true,
  },
  postgres: {
    directory: '04-postgres-persistence',
    projects: ['packages/postgres'],
  },
};
const [name, ...args] = process.argv.slice(2);
const example = examples[name];
const verbose = args.includes('--verbose');
const forwarded = args.filter((arg) => arg !== '--verbose' && arg !== '--');

if (!example || forwarded.some((arg) => arg !== '--no-open')) {
  console.error(
    'Usage: node scripts/examples/run.mjs <hello-world|customer-accounts|customer-workspace|postgres> [--verbose] [--no-open]',
  );
  process.exitCode = 1;
} else {
  console.error(`Preparing ${name.replaceAll('-', ' ')}…`);
  const steps = [
    [
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '-b', ...example.projects],
    ],
    ...(example.client
      ? [
          [
            process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
            ['--filter', '@relate/inspector', 'build:client'],
          ],
        ]
      : []),
  ];

  for (const [command, arguments_] of steps) {
    process.exitCode = await runCommand(command, arguments_, {
      cwd: root,
      quiet: !verbose,
      processTree: true,
      shell: process.platform === 'win32' && command === 'pnpm.cmd',
    });

    if (process.exitCode !== 0) break;
  }

  if (process.exitCode === 0) {
    // Node's optional env file preserves exported variables and needs no wrapper process.
    const envArgs = name === 'postgres' ? ['--env-file-if-exists=.env'] : [];

    process.exitCode = await runCommand(
      process.execPath,
      [
        ...envArgs,
        '--import',
        'tsx',
        `examples/${example.directory}/src/index.ts`,
        ...forwarded,
      ],
      {
        cwd: root,
        env: { ...process.env, RELATE_EXAMPLE_VERBOSE: verbose ? '1' : '0' },
      },
    );
  }
}
