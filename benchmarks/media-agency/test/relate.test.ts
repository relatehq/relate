import { afterEach, expect, it } from 'vitest';
import { generateWorld } from '../src/world/generator.js';
import { createEnvironment } from '../src/systems/environment.js';
import { createAgencyApp } from '../src/relate/app.js';
import { catalogue, instantiate } from '../src/tasks/catalogue.js';
import { createArm } from '../src/harness/arms.js';
import { referenceCode } from '../src/tasks/references.js';
import { grade } from '../src/tasks/grading.js';
import type { Submission } from '../src/tasks/grading.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
it('enforces planner team/field access and cumulative daily budget limits through public calls', async () => {
  const world = generateWorld({ seed: 7, tier: 'S' }),
    env = await createEnvironment(world);

  cleanups.push(env.close);
  const app = await createAgencyApp({
    principal: 'priya',
    http: env.simulators.http,
    db: env.db,
    directory: env.directory,
  });

  cleanups.push(app.close);
  const consumer = app.runtime.as(app.actor);
  const page = await consumer.objects.Client.query({
    select: ['code', 'team', 'feePct'],
  });

  expect(page.data.length).toBe(4);

  for (const record of page.data) {
    expect(record.data.team).toBe('retail');
    expect(record.data).not.toHaveProperty('feePct');
  }

  expect(
    (await consumer.objects.Client.query({ where: { code: { eq: 'HARBOR' } } }))
      .data,
  ).toHaveLength(0);
  await expect(
    consumer.actions.launchAdGroup({
      input: {
        campaign: 'not-visible' as never,
        name: 'forbidden',
        budgetMinor: 5000,
      },
      idempotencyKey: 'forbidden',
    }),
  ).rejects.toThrow();
  const task = instantiate(
    catalogue.find((t) => t.id === 'action.budget-1')!,
    world,
  );
  const campaign = world.campaigns.find(
    (c) => c.id === task.params.campaignId,
  )!;
  const first = await consumer.actions.changeMedia({
    input: {
      platform: 'meta',
      entity: 'campaign',
      externalId: campaign.id,
      budgetMinor: Math.floor(campaign.budgetMinor * 1.15),
    },
    idempotencyKey: 'step-one',
  });

  expect(first.state).toBe('succeeded');
  const second = await consumer.actions.changeMedia({
    input: {
      platform: 'meta',
      entity: 'campaign',
      externalId: campaign.id,
      budgetMinor: campaign.budgetMinor,
    },
    idempotencyKey: 'reverse',
  });

  expect(second).toMatchObject({
    state: 'failed',
    error: { details: { reason: 'exceedsDailyChangeLimit' } },
  });
  expect(env.mutations).toHaveLength(1);
}, 30000);
it('recovers a committed create, adopts within the action and reads its returned identity', async () => {
  const world = generateWorld({ seed: 19, tier: 'S' }),
    task = instantiate(
      catalogue.find((t) => t.id === 'action.create-2')!,
      world,
    );
  const env = await createEnvironment(world, task.faults);

  cleanups.push(env.close);
  const arm = await createArm('relate', 'marco', env);

  cleanups.push(arm.close);
  env.simulators.requests.length = 0;
  const execution = (await arm.call('execute', {
    code: referenceCode(task, 'relate'),
  })) as { status: string; result: Submission };

  expect(execution.status).toBe('succeeded');
  expect(
    grade(task, execution.result, env.mutations, env.simulators.requests, world)
      .passed,
  ).toBe(true);
  expect(env.mutations).toHaveLength(1);
  expect(env.simulators.requests.filter((r) => r.write)).toHaveLength(1);
  const audits = await arm
    .agency!.runtime.as(arm.agency!.actor)
    .objects.MediaChange.query();

  expect(audits.data).toHaveLength(1);
}, 30000);
it('serves the same raw errors and data through the shared code executor', async () => {
  const env = await createEnvironment(generateWorld({ seed: 7, tier: 'S' }));

  cleanups.push(env.close);
  const arm = await createArm('baseline-code', 'marco', env);

  cleanups.push(arm.close);
  const result = await arm.call('execute', {
    code: "return await sql('plans', 'SELECT COUNT(*) AS count FROM plan_lines');",
  });

  expect(result).toMatchObject({
    status: 'succeeded',
    result: [{ count: 144 }],
  });
  expect(
    await arm.call('execute', { code: 'return typeof graph;' }),
  ).toMatchObject({ status: 'succeeded', result: 'undefined' });
});

it('bounds raw SQL materialization and leaves the next query usable', async () => {
  const env = await createEnvironment(generateWorld({ seed: 7, tier: 'S' }));

  cleanups.push(env.close);
  const arm = await createArm('baseline-tools', 'marco', env);

  cleanups.push(arm.close);
  const result = (await arm.call('sql_query', {
    db: 'warehouse',
    sql: 'SELECT * FROM delivery_daily_ad',
  })) as { rows: unknown[]; rowCount: number; truncated: boolean };

  expect(result.rows).toHaveLength(2000);
  expect(result.rowCount).toBe(2000);
  expect(result.truncated).toBe(true);
  expect(
    await arm.call('sql_query', {
      db: 'warehouse',
      sql: 'SELECT COUNT(*) AS count FROM delivery_daily_ad',
    }),
  ).toMatchObject({
    rows: [{ count: '171840' }],
    rowCount: 1,
    truncated: false,
  });
});

it('explains invalid action values without provider access and accepts a corrected TTD change', async () => {
  const world = generateWorld({ seed: 19, tier: 'S' }),
    env = await createEnvironment(world);

  cleanups.push(env.close);
  const app = await createAgencyApp({
    principal: 'marco',
    http: env.simulators.http,
    db: env.db,
    directory: env.directory,
  });

  cleanups.push(app.close);
  const consumer = app.runtime.as(app.actor);
  const task = instantiate(
    catalogue.find((t) => t.id === 'action.status-3')!,
    world,
  );
  const input = {
    platform: 'ttd',
    entity: 'campaign',
    externalId: task.params.campaignId,
    status: 'PAUSED',
  };
  const before = env.simulators.requests.length;

  for (const [index, change] of [
    { ...input, platform: 'TTD' },
    { ...input, entity: 'Campaign' },
    { ...input, status: 'paused' },
    { ...input, budgetMinor: 100 },
  ].entries()) {
    const result = await consumer.actions.changeMedia({
      input: change,
      idempotencyKey: `invalid-${index}`,
    });

    expect(result).toMatchObject({
      state: 'failed',
      error: {
        code: 'rejected',
        details: { reason: expect.stringContaining('no write dispatched') },
      },
    });
  }

  expect(env.simulators.requests).toHaveLength(before);
  expect(env.mutations).toHaveLength(0);
  expect(
    (await consumer.actions.changeMedia.describe())?.description,
  ).toContain('ttd');
  expect(
    (await consumer.actions.changeMedia({ input, idempotencyKey: 'corrected' }))
      .state,
  ).toBe('succeeded');
  expect(
    grade(
      task,
      { answer: { applied: true }, caveats: [] },
      env.mutations,
      env.simulators.requests,
      world,
    ).passed,
  ).toBe(true);
}, 30000);

it('exposes units and identities and computes custom date-range spend without a tenfold conversion error', async () => {
  const world = generateWorld({ seed: 19, tier: 'S' }),
    env = await createEnvironment(world);

  cleanups.push(env.close);
  const arm = await createArm('relate', 'marco', env);

  cleanups.push(arm.close);
  const task = instantiate(
    catalogue.find((t) => t.id === 'aggregation.spend-3')!,
    world,
  );
  const description = await arm
    .agency!.runtime.as(arm.agency!.actor)
    .objects.TtdCampaign.describe();

  expect(
    description?.properties.find((p) => p.name === 'externalId')?.description,
  ).toContain('Platform record ID');
  expect(
    description?.properties.find((p) => p.name === 'spendAccountMinor')
      ?.description,
  ).toContain('10000.0');
  const execution = await arm.call('execute', {
    code: `const r=await graph.objects.TtdCampaign.query({where:{externalId:{eq:${JSON.stringify(task.params.campaignId)}}},compute:{windowSpend:{sql:"SELECT SUM(spendMicros)/10000.0 FROM self.delivery WHERE date >= $start AND date <= $end",parameters:{start:${JSON.stringify(task.params.from)},end:${JSON.stringify(task.params.to)}}}}}); const d=r.data[0].data; return {id:d.externalId,spendMinor:d.windowSpend,currency:d.accountCurrency};`,
  });

  expect(execution).toMatchObject({
    status: 'succeeded',
    result: task.expected,
  });
}, 30000);
