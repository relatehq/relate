import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readEnvValue } from './planning.js';
import { listWorktrees, output } from './runtime.js';

for (const [index, worktree] of listWorktrees().entries()) {
  const envPath = resolve(worktree.path, '.env');
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const database = readEnvValue(env, 'DATABASE_URL');
  const changes = existsSync(worktree.path)
    ? output('git', ['status', '--short'], worktree.path)
        .split('\n')
        .filter(Boolean).length
    : undefined;

  console.log(`${worktree.path}${index === 0 ? '  (main checkout)' : ''}`);
  console.log(
    `  branch:  ${worktree.branch ?? `detached at ${worktree.head}`}`,
  );
  console.log(
    `  changes: ${changes === undefined ? 'path missing' : changes || 'clean'}`,
  );
  console.log(
    `  db:      ${database ? new URL(database).pathname.slice(1) : '(no .env)'}`,
  );
}
