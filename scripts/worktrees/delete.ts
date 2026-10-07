import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { droppableDatabaseUrls, findWorktree } from './planning.js';
import {
  callerCwd,
  dropDatabases,
  listWorktrees,
  output,
  run,
  succeeds,
} from './runtime.js';

const usage = `Usage: pnpm worktree:delete <name|branch|path> [--force] [--keep-branch] [--dry-run]

Drops the worktree's relate_<name> databases, removes the worktree, and deletes
its branch when the branch is merged into main. Refuses a worktree with
uncommitted changes unless --force is given. An unmerged branch is always kept.

Example:
  pnpm worktree:delete receipt-lookup`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      force: { type: 'boolean', default: false },
      'keep-branch': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const reference = positionals[0];

  if (!reference || values.help) {
    console.log(usage);
    process.exit(reference ? 0 : 1);
  }

  const dryRun = values['dry-run'];
  const worktrees = listWorktrees();
  const checkout = worktrees[0]!.path;
  const worktree = findWorktree(worktrees, reference, callerCwd);

  if (!worktree) throw new Error(`No worktree matches "${reference}".`);

  if (resolve(worktree.path) === resolve(checkout))
    throw new Error(`Refusing to delete the main checkout: ${checkout}`);

  if (
    `${resolve(callerCwd)}${sep}`.startsWith(`${resolve(worktree.path)}${sep}`)
  )
    throw new Error('Run this from outside the worktree being deleted.');

  if (existsSync(worktree.path)) {
    const status = output('git', ['status', '--short'], worktree.path).trim();

    if (status && !values.force)
      throw new Error(
        `Refusing to delete ${worktree.path}: it has uncommitted changes. Commit or stash them, or rerun with --force.\n${status}`,
      );
  }

  const envPath = resolve(worktree.path, '.env');

  if (existsSync(envPath)) {
    const { app, test } = droppableDatabaseUrls(readFileSync(envPath, 'utf8'));

    if (dryRun) console.log(`[dry-run] drop ${app}, ${test}`);
    else {
      await dropDatabases([app, test]);
      console.log('Dropped worktree databases.');
    }
  } else console.log('No .env found; no databases to drop.');

  run(
    'git',
    ['worktree', 'remove', ...(values.force ? ['--force'] : []), worktree.path],
    { cwd: checkout, dryRun },
  );
  run('git', ['worktree', 'prune'], { cwd: checkout, dryRun });

  if (worktree.branch && !values['keep-branch']) {
    const merged = succeeds(
      'git',
      ['merge-base', '--is-ancestor', worktree.branch, 'main'],
      checkout,
    );

    if (merged)
      run('git', ['branch', '-d', worktree.branch], { cwd: checkout, dryRun });
    else
      console.log(
        `Kept branch ${worktree.branch}: it has commits that are not in main.`,
      );
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Deleted ${worktree.path}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
