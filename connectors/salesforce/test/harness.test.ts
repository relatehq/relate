import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, onTestFinished, test } from 'vitest';
import { ScratchOrg } from '@relate/dev-salesforce/harness';
import type { Cli } from '@relate/dev-salesforce/harness';

async function fixture() {
  const path = join(
    await mkdtemp(join(tmpdir(), 'relate-sf-test-')),
    'state.json',
  );

  onTestFinished(() => rm(join(path, '..'), { recursive: true, force: true }));
  const hub = '00D000000000001EAA';
  const scratch = '00D000000000002EAA';
  let username = '';
  let seedFails = false;
  let deleteFails = false;
  let listedId = scratch;
  let listedHub = 'hub@example.com';
  let created = false;
  let seeds = 0;
  const calls: string[][] = [];
  const cli: Cli = async (args) => {
    calls.push(args);
    const command = args.slice(0, 3).join(' ');

    if (command === 'org list --all')
      return {
        nonScratchOrgs: [
          {
            orgId: hub,
            username: 'hub@example.com',
            isDevHub: true,
            isDefaultDevHubUsername: true,
          },
        ],
        scratchOrgs: created
          ? [
              {
                orgId: listedId,
                username,
                devHubUsername: listedHub,
                isScratch: true,
              },
            ]
          : [],
      };

    if (command === 'org create scratch') {
      username = args[args.indexOf('--username') + 1]!;
      expect(JSON.parse(await readFile(path, 'utf8')).username).toBe(username);
      expect(args).toContain('--async');
      expect(args[args.indexOf('--duration-days') + 1]).toBe('1');
      created = true;

      return { scratchOrgInfo: { Id: '2SR000000000001GAA' } };
    }

    if (command === 'org resume scratch') return { orgId: scratch, username };

    if (command === 'data create record') {
      if (seedFails) throw new Error('fixture seed failed');

      seeds++;

      return { success: true, id: `00100000000000${seeds}AAA` };
    }

    if (command === 'org delete scratch') {
      if (deleteFails) throw new Error('fixture delete failed');

      expect(args[args.indexOf('--target-org') + 1]).toBe(username);
      created = false;

      return {};
    }

    if (command === 'data query --target-org')
      return { records: [{ Id: '2SR000000000001GAA' }] };

    if (command === 'data delete record') return {};

    throw new Error(`Unexpected mock command ${command}`);
  };

  return {
    org: new ScratchOrg(path, cli),
    path,
    calls,
    failSeed: () => {
      seedFails = true;
    },
    failDelete: () => {
      deleteFails = true;
    },
    retargetHub: () => {
      listedId = hub;
    },
    retargetOwner: () => {
      listedHub = 'other@example.com';
    },
  };
}

test('persists ownership before provisioning, seeds, resets only owned IDs and deletes the scratch org', async () => {
  const f = await fixture();

  await f.org.create(new AbortController().signal);
  const before = await f.org.info();

  expect(before.accountIds).toHaveLength(2);
  await f.org.reset();
  expect(
    f.calls
      .filter((args) => args.slice(0, 3).join(' ') === 'data delete record')
      .map((args) => args[args.indexOf('--record-id') + 1]),
  ).toEqual(before.accountIds);
  await f.org.destroy();
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('failed seeding still deletes the owned org', async () => {
  const f = await fixture();

  f.failSeed();
  await expect(f.org.create(new AbortController().signal)).rejects.toThrow(
    'fixture seed failed',
  );
  expect(
    f.calls.some((args) => args.slice(0, 3).join(' ') === 'org delete scratch'),
  ).toBe(true);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['retargetHub', 'retargetOwner'] as const)(
  'refuses mutation after %s',
  async (change) => {
    const f = await fixture();

    await f.org.create(new AbortController().signal);
    f[change]();
    await expect(f.org.destroy()).rejects.toThrow(
      'not the recorded scratch org',
    );
    await expect(f.org.reset()).rejects.toThrow('not the recorded scratch org');
    expect(
      f.calls.some(
        (args) => args.slice(0, 3).join(' ') === 'org delete scratch',
      ),
    ).toBe(false);
  },
);

test('retains recovery information if teardown fails', async () => {
  const f = await fixture();

  await f.org.create(new AbortController().signal);
  f.failDelete();
  await expect(f.org.destroy()).rejects.toThrow('fixture delete failed');
  expect(JSON.parse(await readFile(f.path, 'utf8')).orgId).toBe(
    '00D000000000002EAA',
  );
});

test('recovers a lost provisioning response through the recorded unique username', async () => {
  const f = await fixture();

  await f.org.create(new AbortController().signal);
  const state = JSON.parse(await readFile(f.path, 'utf8'));

  delete state.jobId;
  delete state.orgId;
  await writeFile(f.path, JSON.stringify(state));
  await f.org.destroy();
  const query = f.calls.find(
    (args) => args[0] === 'data' && args[1] === 'query',
  )!;

  expect(query[query.indexOf('--query') + 1]).toContain(state.username);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('does not replace a previous run or consume another org allocation', async () => {
  const f = await fixture();

  await f.org.create(new AbortController().signal);
  await expect(
    f.org.create(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(
    f.calls.filter(
      (args) => args.slice(0, 3).join(' ') === 'org create scratch',
    ),
  ).toHaveLength(1);
});
