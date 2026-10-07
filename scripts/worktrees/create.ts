import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildWorktreePlan,
  readEnvValue,
  renderWorktreeEnv,
} from './planning.js';
import {
  callerCwd,
  createDatabases,
  existingDatabases,
  primaryCheckout,
  readPrimaryEnv,
  run,
  succeeds,
} from './runtime.js';

const usage = `Usage: pnpm worktree:create <branch> [--base main] [--path /abs/path] [--skip-install] [--skip-db] [--dry-run]

Creates ../relate-worktrees/<name> on a new branch (or checks out an existing
local branch), writes .env with its own relate_<name> and relate_<name>_test
databases, creates those databases, installs dependencies, and builds.

Example:
  pnpm worktree:create feat/receipt-lookup`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: 'string', default: 'main' },
      path: { type: 'string' },
      'skip-install': { type: 'boolean', default: false },
      'skip-db': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const branchName = positionals[0];

  if (!branchName || values.help) {
    console.log(usage);
    process.exit(branchName ? 0 : 1);
  }

  const dryRun = values['dry-run'];
  const checkout = primaryCheckout();
  const baseEnv = readPrimaryEnv(checkout);
  const baseDatabaseUrl = readEnvValue(baseEnv, 'DATABASE_URL');

  if (!baseDatabaseUrl)
    throw new Error(`DATABASE_URL is not set in ${checkout}/.env.`);

  const plan = buildWorktreePlan({
    branchName,
    primaryCheckout: checkout,
    baseDatabaseUrl,
    explicitPath: values.path ? resolve(callerCwd, values.path) : undefined,
  });
  const databaseUrls = values['skip-db'] ? [] : [plan.urls.app, plan.urls.test];
  const branchExists = succeeds(
    'git',
    ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
    checkout,
  );

  // Check everything that can fail before changing anything.
  if (existsSync(plan.targetPath))
    throw new Error(`Target path already exists: ${plan.targetPath}`);

  const taken = await existingDatabases(databaseUrls);

  if (taken.length > 0)
    throw new Error(
      `Databases already exist: ${taken.join(', ')}. Delete the old worktree first, or choose another branch name.`,
    );

  console.log(
    `Branch:    ${branchName}${branchExists ? ' (existing)' : ` (new, from ${values.base})`}`,
  );
  console.log(`Path:      ${plan.targetPath}`);
  console.log(
    values['skip-db']
      ? 'Databases: skipped'
      : `Databases: ${plan.databases.app}, ${plan.databases.test}`,
  );
  console.log('');

  run(
    'git',
    branchExists
      ? ['worktree', 'add', plan.targetPath, branchName]
      : ['worktree', 'add', '-b', branchName, plan.targetPath, values.base],
    { cwd: checkout, dryRun },
  );

  if (dryRun) console.log(`[dry-run] write ${plan.targetPath}/.env`);
  else {
    mkdirSync(plan.targetPath, { recursive: true });
    writeFileSync(
      resolve(plan.targetPath, '.env'),
      renderWorktreeEnv(baseEnv, plan),
    );
  }

  if (dryRun && databaseUrls.length > 0)
    console.log(
      `[dry-run] create ${plan.databases.app}, ${plan.databases.test}`,
    );
  else await createDatabases(databaseUrls);

  if (!values['skip-install']) {
    run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: plan.targetPath,
      dryRun,
    });
    run('pnpm', ['build'], { cwd: plan.targetPath, dryRun });
  }

  console.log('');
  console.log(`Worktree ready: ${plan.targetPath}`);
  console.log(`Remove it with: pnpm worktree:delete ${plan.slug}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
