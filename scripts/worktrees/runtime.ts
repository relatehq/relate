import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { parseWorktreeList } from './planning.js';

/** pnpm runs scripts from the package root; INIT_CWD is where it was called. */
export const callerCwd = process.env.INIT_CWD ?? process.cwd();

export function run(
  command: string,
  args: string[],
  options: { cwd: string; dryRun?: boolean },
) {
  const printable = [command, ...args].join(' ');

  if (options.dryRun) {
    console.log(`[dry-run] (${options.cwd}) ${printable}`);

    return;
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: 'inherit',
  });

  if (result.status !== 0)
    throw new Error(`${printable} failed with exit code ${result.status}`);
}

export function output(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });

  if (result.status !== 0)
    throw new Error(
      `${[command, ...args].join(' ')} failed with exit code ${result.status}: ${result.stderr}`,
    );

  return result.stdout;
}

export function succeeds(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, stdio: 'ignore' }).status === 0;
}

export function listWorktrees(cwd = process.cwd()) {
  return parseWorktreeList(
    output('git', ['worktree', 'list', '--porcelain'], cwd),
  );
}

/**
 * The main checkout is always the first entry, so these commands behave the
 * same when run from inside another worktree.
 */
export function primaryCheckout(cwd = process.cwd()) {
  const primary = listWorktrees(cwd)[0];

  if (!primary) throw new Error('Not inside a Git repository.');

  return primary.path;
}

export function readPrimaryEnv(checkout: string) {
  for (const name of ['.env', '.env.example']) {
    const path = resolve(checkout, name);

    if (existsSync(path)) return readFileSync(path, 'utf8');
  }

  throw new Error(`Expected .env or .env.example in ${checkout}.`);
}

/** Runs `work` against the server's `postgres` maintenance database. */
async function withServer<T>(
  databaseUrl: string,
  work: (client: pg.Client) => Promise<T>,
) {
  const url = new URL(databaseUrl);

  url.pathname = '/postgres';

  const client = new pg.Client({ connectionString: url.toString() });

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not connect to Postgres at ${url.host}. Start the local server or pass --skip-db.`,
      { cause: error },
    );
  }

  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const databaseName = (databaseUrl: string) =>
  new URL(databaseUrl).pathname.slice(1);

export async function existingDatabases(databaseUrls: string[]) {
  const names = databaseUrls.map(databaseName);

  if (names.length === 0) return [];

  return withServer(databaseUrls[0]!, async (client) => {
    const result = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1)',
      [names],
    );

    return result.rows.map((row) => row.datname);
  });
}

export async function createDatabases(databaseUrls: string[]) {
  if (databaseUrls.length === 0) return;

  await withServer(databaseUrls[0]!, async (client) => {
    for (const name of databaseUrls.map(databaseName))
      await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  });
}

export async function dropDatabases(databaseUrls: string[]) {
  if (databaseUrls.length === 0) return;

  await withServer(databaseUrls[0]!, async (client) => {
    for (const name of databaseUrls.map(databaseName))
      await client.query(
        `DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`,
      );
  });
}
