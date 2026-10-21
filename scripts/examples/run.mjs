import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runCommand } from './process.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const examples = {
  'todo-notes': { directory: '01-todo-notes', projects: ['packages/node'] },
  'customer-workspace': {
    directory: '02-customer-workspace',
    projects: ['packages/cli', 'connectors/sqlite'],
    client: true,
  },
  'customer-events': {
    directory: '04-customer-events',
    projects: ['packages/node', 'connectors/sqlite'],
  },
  postgres: {
    directory: '03-postgres-persistence',
    projects: ['packages/postgres'],
  },
};
const [name, ...args] = process.argv.slice(2);
const example = examples[name];
const verbose = args.includes('--verbose');
const forwarded = args.filter((arg) => arg !== '--verbose' && arg !== '--');

if (!example || forwarded.some((arg) => arg !== '--no-open')) {
  console.error(
    'Usage: node scripts/examples/run.mjs <todo-notes|customer-workspace|postgres|customer-events> [--verbose] [--no-open]',
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
    const envArgs =
      name === 'postgres' || name === 'customer-workspace'
        ? ['--env-file-if-exists=.env']
        : [];

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
