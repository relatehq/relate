import { afterEach, expect, it } from 'vitest';
import { generateWorld } from '../src/world/generator.js';
import { createEnvironment } from '../src/systems/environment.js';
import { checked, listPlatform } from '../src/systems/platform.js';
import { catalogue, instantiate, spend } from '../src/tasks/catalogue.js';
import { grade } from '../src/tasks/grading.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
it('serves real SQL date aggregates and paged provider records from the same truth', async () => {
  const world = generateWorld({ seed: 19, tier: 'S' }),
    env = await createEnvironment(world);

  cleanups.push(env.close);

  for (const platform of ['meta', 'tiktok', 'ttd', 'google-ads'] as const)
    expect(
      await listPlatform(env.simulators.http, platform, 'campaign'),
    ).toHaveLength(
      world.campaigns.filter((c) => c.platform === platform).length,
    );

  const tiktokAccounts = new Set(
    world.accounts
      .filter((a) => a.loadedThrough === '2026-10-12')
      .map((a) => a.id),
  );
  const id = world.campaigns.find(
    (c) =>
      tiktokAccounts.has(c.accountId) &&
      c.status === 'ACTIVE' &&
      c.flightEnd === '2026-10-31',
  )!.id;
  const result = await env.db.sql(
    'warehouse',
    'SELECT SUM(spend_micros)/10000.0 spend, CAST(MAX(date) AS VARCHAR) latest FROM delivery_daily_campaign WHERE platform_campaign_id = ? AND date >= ?::DATE',
    [id, '2026-10-01'],
  );

  expect(Number(result[0]!.spend)).toBe(
    spend(world, id, '2026-10-01', '2026-10-14'),
  );
  expect(result[0]!.latest).toBe('2026-10-12');
  await expect(
    env.db.sql('warehouse', 'DELETE FROM delivery_daily_campaign'),
  ).rejects.toThrow();
  await expect(env.db.sql('plans', 'DELETE FROM plan_lines')).rejects.toThrow();
});
it('loses the create response after commit and grades a blind retry as a duplicate business effect', async () => {
  const world = generateWorld({ seed: 7, tier: 'S' }),
    task = instantiate(
      catalogue.find((t) => t.id === 'action.create-2')!,
      world,
    );
  const env = await createEnvironment(world, task.faults);

  cleanups.push(env.close);
  const request = {
    method: 'POST',
    path: '/open_api/v1.3/adgroup/create/',
    body: {
      campaign_id: task.params.campaignId,
      adgroup_name: task.params.name,
      budget: 50,
    },
  };

  await expect(env.simulators.http('tiktok', request)).rejects.toThrow();
  expect(env.mutations).toHaveLength(1);
  await env.simulators.http('tiktok', request);
  expect(env.mutations).toHaveLength(2);
  const result = grade(
    task,
    { answer: {}, caveats: [] },
    env.mutations,
    env.simulators.requests,
    world,
  );

  expect(result.passed).toBe(false);
  expect(result.mistakes).toContain('duplicate-write');
});
it('full-object TTD writes clobber omitted fields; repeated absolute writes are distinct from transitions', async () => {
  const world = generateWorld({ seed: 7, tier: 'S' }),
    task = instantiate(
      catalogue.find((t) => t.id === 'action.status-2')!,
      world,
    ),
    env = await createEnvironment(world);

  cleanups.push(env.close);
  const row = await checked(env.simulators.http, 'ttd', {
    path: `/v3/campaign/${task.params.campaignId}`,
  });

  await checked(env.simulators.http, 'ttd', {
    method: 'PUT',
    path: '/v3/campaign',
    body: { Id: row.Id, Status: task.params.desiredStatus },
  });
  const result = grade(
    task,
    { answer: { applied: true }, caveats: [] },
    env.mutations,
    env.simulators.requests,
    world,
  );

  expect(result.mistakes).toContain('clobber');
});

it('rejects IDs from a different provider without mutating either system', async () => {
  const world = generateWorld({ seed: 7, tier: 'S' });
  const env = await createEnvironment(world);

  cleanups.push(env.close);
  const foreignId = world.campaigns.find((c) => c.platform === 'meta')!.id;

  expect(
    (
      await env.simulators.http('meta', {
        path: `/v21.0/${world.accounts.find((a) => a.platform === 'meta')!.id}/campaigns`,
        query: { fields: '*' },
      })
    ).status,
  ).toBe(400);
  const response = await env.simulators.http('ttd', {
    method: 'PUT',
    path: '/v3/campaign',
    body: { Id: foreignId, Status: 'PAUSED' },
  });

  expect(response.status).toBe(400);
  expect(env.mutations).toHaveLength(0);
  expect(env.simulators.requests.at(-1)?.outcome).toBe('provider-error');
});
