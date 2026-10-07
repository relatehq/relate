import { basename, dirname, join, resolve } from 'node:path';

// Conventional Commit types, used as branch prefixes.
const BRANCH_PREFIXES = [
  'feat',
  'feature',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'build',
  'ci',
  'perf',
  'style',
] as const;

// `relate_<slug>_test` must fit the 63-byte Postgres identifier limit.
const MAX_SLUG_LENGTH = 48;
const DATABASE_PREFIX = 'relate_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type WorktreePlan = {
  branchName: string;
  slug: string;
  targetPath: string;
  databases: { app: string; test: string };
  urls: { app: string; test: string };
};

export type WorktreeEntry = {
  path: string;
  branch: string | undefined;
  head: string | undefined;
};

export function assertValidBranchName(branchName: string) {
  const prefix = branchName.split('/')[0];

  if (
    !branchName.includes('/') ||
    !BRANCH_PREFIXES.includes(prefix as (typeof BRANCH_PREFIXES)[number])
  )
    throw new Error(
      `Branch name must start with one of: ${BRANCH_PREFIXES.map((value) => `${value}/`).join(', ')}`,
    );

  if (!/^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/.test(branchName))
    throw new Error(
      'Branch name must use lowercase letters, numbers, dots, dashes, underscores, and slashes.',
    );
}

/** `feat/durable-receipts` -> `durable-receipts`. */
export function slugFromBranchName(branchName: string) {
  assertValidBranchName(branchName);

  const slug = branchName
    .replace(/^[a-z]+\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug)
    throw new Error(`Could not derive a worktree name from ${branchName}`);

  if (slug.length > MAX_SLUG_LENGTH)
    throw new Error(
      `Worktree name "${slug}" is ${slug.length} chars; keep it at or under ${MAX_SLUG_LENGTH}.`,
    );

  return slug;
}

/** The sibling folder that holds every worktree: `../relate-worktrees`. */
export function worktreesRoot(primaryCheckout: string) {
  const root = resolve(primaryCheckout);

  return join(dirname(root), `${basename(root)}-worktrees`);
}

export function buildWorktreePlan(input: {
  branchName: string;
  primaryCheckout: string;
  baseDatabaseUrl: string;
  explicitPath?: string | undefined;
}): WorktreePlan {
  const slug = slugFromBranchName(input.branchName);
  const app = `${DATABASE_PREFIX}${slug.replaceAll('-', '_')}`;
  const test = `${app}_test`;
  const urlFor = (database: string) => {
    const url = new URL(input.baseDatabaseUrl);

    url.pathname = `/${database}`;

    return url.toString();
  };

  return {
    branchName: input.branchName,
    slug,
    targetPath:
      input.explicitPath ?? join(worktreesRoot(input.primaryCheckout), slug),
    databases: { app, test },
    urls: { app: urlFor(app), test: urlFor(test) },
  };
}

/** Copies the primary `.env`, replacing only the database URLs. */
export function renderWorktreeEnv(baseEnv: string, plan: WorktreePlan) {
  const overrides = new Map([
    ['DATABASE_URL', plan.urls.app],
    ['RELATE_TEST_DATABASE_URL', plan.urls.test],
  ]);
  const seen = new Set<string>();
  const lines = baseEnv
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => {
      const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
      const value = key === undefined ? undefined : overrides.get(key);

      if (key === undefined || value === undefined) return line;

      seen.add(key);

      return `${key}=${value}`;
    });

  for (const [key, value] of overrides)
    if (!seen.has(key)) lines.push(`${key}=${value}`);

  return `${lines.join('\n')}\n`;
}

export function readEnvValue(envContent: string, key: string) {
  return envContent.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim();
}

/**
 * Returns the worktree's database URLs only when they are safe to drop: both on
 * a local server, named `relate_<slug>` and `relate_<slug>_test`. This keeps
 * cleanup away from the primary `relate` and `relate_test` databases and from
 * any other application's databases.
 */
export function droppableDatabaseUrls(envContent: string) {
  const app = readEnvValue(envContent, 'DATABASE_URL');
  const test = readEnvValue(envContent, 'RELATE_TEST_DATABASE_URL');

  if (!app || !test)
    throw new Error(
      'Worktree .env must set DATABASE_URL and RELATE_TEST_DATABASE_URL.',
    );

  const [appUrl, testUrl] = [new URL(app), new URL(test)];
  const appName = appUrl.pathname.slice(1);
  const testName = testUrl.pathname.slice(1);

  if (
    !LOCAL_HOSTS.has(appUrl.hostname) ||
    appUrl.host !== testUrl.host ||
    !appUrl.protocol.startsWith('postgres')
  )
    throw new Error(
      'Refusing to drop databases that are not on the same local Postgres server.',
    );

  if (
    !new RegExp(`^${DATABASE_PREFIX}[a-z0-9_]+$`).test(appName) ||
    appName.endsWith('_test') ||
    testName !== `${appName}_test`
  )
    throw new Error(
      `Refusing to drop "${appName}" and "${testName}": they are not a worktree database pair.`,
    );

  return { app, test };
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];

  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const path = lines
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length);

    if (!path) continue;

    entries.push({
      path,
      branch: lines
        .find((line) => line.startsWith('branch '))
        ?.slice('branch refs/heads/'.length),
      head: lines
        .find((line) => line.startsWith('HEAD '))
        ?.slice('HEAD '.length),
    });
  }

  return entries;
}

/** Finds a worktree by path, branch name, or folder name. */
export function findWorktree(
  entries: WorktreeEntry[],
  reference: string,
  cwd: string,
) {
  const path = resolve(cwd, reference);

  return (
    entries.find((entry) => resolve(entry.path) === path) ??
    entries.find((entry) => entry.branch === reference) ??
    entries.find((entry) => basename(entry.path) === reference)
  );
}
