import { describe, expect, it } from 'vitest';
import {
  buildWorktreePlan,
  droppableDatabaseUrls,
  findWorktree,
  parseWorktreeList,
  renderWorktreeEnv,
  slugFromBranchName,
} from '../../scripts/worktrees/planning.js';

const plan = buildWorktreePlan({
  branchName: 'feat/receipt-lookup',
  primaryCheckout: '/dev/vs/relate',
  baseDatabaseUrl: 'postgresql://postgres:postgres@localhost:5433/relate',
});

describe('worktree planning', () => {
  it('places worktrees in the sibling folder with their own databases', () => {
    expect(plan).toEqual({
      branchName: 'feat/receipt-lookup',
      slug: 'receipt-lookup',
      targetPath: '/dev/vs/relate-worktrees/receipt-lookup',
      databases: {
        app: 'relate_receipt_lookup',
        test: 'relate_receipt_lookup_test',
      },
      urls: {
        app: 'postgresql://postgres:postgres@localhost:5433/relate_receipt_lookup',
        test: 'postgresql://postgres:postgres@localhost:5433/relate_receipt_lookup_test',
      },
    });
  });

  it('requires a Conventional Commit prefix and a short, lowercase name', () => {
    expect(slugFromBranchName('fix/durable.receipts_v2')).toBe(
      'durable-receipts-v2',
    );
    expect(() => slugFromBranchName('receipt-lookup')).toThrow(/start with/);
    expect(() => slugFromBranchName('feat/Receipt')).toThrow(/lowercase/);
    expect(() => slugFromBranchName(`feat/${'a'.repeat(49)}`)).toThrow(
      /at or under 48/,
    );
  });

  it('replaces only the database URLs in the copied environment', () => {
    const env = renderWorktreeEnv(
      [
        '# Local Docker Postgres',
        'DATABASE_URL=postgresql://postgres:postgres@localhost:5433/relate',
        'OTHER=kept',
        '',
      ].join('\n'),
      plan,
    );

    expect(env).toBe(
      [
        '# Local Docker Postgres',
        `DATABASE_URL=${plan.urls.app}`,
        'OTHER=kept',
        `RELATE_TEST_DATABASE_URL=${plan.urls.test}`,
        '',
      ].join('\n'),
    );
  });
});

describe('worktree cleanup', () => {
  const env = (app: string, test: string) =>
    `DATABASE_URL=${app}\nRELATE_TEST_DATABASE_URL=${test}\n`;
  const local = 'postgresql://postgres:postgres@localhost:5433';

  it('drops only a local relate_<name> database pair', () => {
    expect(droppableDatabaseUrls(renderWorktreeEnv('', plan))).toEqual(
      plan.urls,
    );
  });

  it.each([
    ['the primary databases', `${local}/relate`, `${local}/relate_test`],
    ['another application', `${local}/arc_x`, `${local}/arc_x_test`],
    ['a mismatched pair', `${local}/relate_a`, `${local}/relate_b_test`],
    [
      'a remote server',
      'postgresql://u:p@db.example.com:5432/relate_a',
      'postgresql://u:p@db.example.com:5432/relate_a_test',
    ],
  ])('refuses %s', (_, app, test) => {
    expect(() => droppableDatabaseUrls(env(app, test))).toThrow(/Refusing/);
  });
});

describe('worktree lookup', () => {
  const entries = parseWorktreeList(
    [
      'worktree /dev/vs/relate',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /dev/vs/relate-worktrees/receipt-lookup',
      'HEAD bbb',
      'branch refs/heads/feat/receipt-lookup',
      '',
      'worktree /dev/vs/relate-worktrees/spike',
      'HEAD ccc',
      'detached',
      '',
    ].join('\n'),
  );

  it('parses branches and detached heads', () => {
    expect(entries).toEqual([
      { path: '/dev/vs/relate', branch: 'main', head: 'aaa' },
      {
        path: '/dev/vs/relate-worktrees/receipt-lookup',
        branch: 'feat/receipt-lookup',
        head: 'bbb',
      },
      {
        path: '/dev/vs/relate-worktrees/spike',
        branch: undefined,
        head: 'ccc',
      },
    ]);
  });

  it('finds a worktree by path, branch, or folder name', () => {
    const target = entries[1];

    expect(findWorktree(entries, 'receipt-lookup', '/dev/vs/relate')).toBe(
      target,
    );
    expect(findWorktree(entries, 'feat/receipt-lookup', '/elsewhere')).toBe(
      target,
    );
    expect(
      findWorktree(
        entries,
        '../relate-worktrees/receipt-lookup',
        '/dev/vs/relate',
      ),
    ).toBe(target);
    expect(findWorktree(entries, 'missing', '/dev/vs/relate')).toBeUndefined();
  });
});
