import { expect, it, onTestFinished } from 'vitest';
import { startApp } from '@relate/node';
import { app } from '../src/app.js';
import { actors } from '../src/graph.js';
import { seed } from '../src/seed.js';
import {
  clickThroughRate,
  reach,
  servedInWindow,
  videoClicks,
} from '../src/queries.js';

async function startSeeded() {
  const runtime = await startApp(app);

  onTestFinished(() => runtime.close());
  await seed(runtime);

  return runtime;
}

// Query order is unspecified without orderBy; ordinary properties cannot be ordered.
const byName = (a: { name?: string }, b: { name?: string }) =>
  String(a.name).localeCompare(String(b.name));

it('reads Salesforce advertisers in the actor team only', async () => {
  const runtime = await startSeeded();
  const page = await runtime.as(actors.ana).objects.Advertiser.query({
    select: ['name', 'industry', 'team'],
  });

  const rows = page.data.map((row) => row.data).sort(byName);

  expect(rows).toEqual([
    { name: 'Brightwater Travel', industry: 'Travel', team: 'emea' },
    { name: 'Kestrel Running', industry: 'Retail', team: 'emea' },
  ]);
});

it('ranks SQLite campaigns by DuckDB clicks and withholds spend from account managers', async () => {
  const runtime = await startSeeded();
  const page = await runtime.as(actors.ana).objects.Campaign.query({
    select: ['name', 'served', 'clicks', 'spendMicros', 'budgetMinor'],
    orderBy: [{ field: 'clicks', direction: 'desc' }],
  });

  // Harbor Bank's Savings Push belongs to the apac team and is not returned.
  expect(page.data.map((row) => row.data)).toEqual([
    { name: 'City Breaks', served: '40', clicks: '6' },
    { name: 'Trail Launch', served: '50', clicks: '4' },
    { name: 'Autumn Escapes', served: '25', clicks: '1' },
    { name: 'Retargeting Test', served: '0', clicks: '0' },
  ]);
  expect(page.data[0]!.meta.fields).toMatchObject({
    clicks: { status: 'available', source: 'computed' },
    spendMicros: { status: 'forbidden' },
    budgetMinor: { status: 'forbidden' },
  });
});

it('shows spend and budget to finance', async () => {
  const runtime = await startSeeded();
  const page = await runtime.as(actors.fin).objects.Campaign.query({
    select: ['name', 'budgetMinor', 'spendMicros'],
    orderBy: [{ field: 'spendMicros', direction: 'desc' }],
  });

  expect(page.data.map((row) => row.data)).toEqual([
    { name: 'Trail Launch', budgetMinor: 1_200_000, spendMicros: '150000' },
    { name: 'City Breaks', budgetMinor: 1_500_000, spendMicros: '100000' },
    { name: 'Autumn Escapes', budgetMinor: 800_000, spendMicros: '45000' },
    { name: 'Retargeting Test', budgetMinor: 200_000, spendMicros: '0' },
  ]);
});

it('evaluates caller expressions and filters on them', async () => {
  const runtime = await startSeeded();
  const campaign = runtime.as(actors.ana).objects.Campaign;
  const page = await campaign.query({
    select: ['name'],
    compute: { servedInWindow, videoClicks },
  });

  const rows = page.data.map((row) => row.data).sort(byName);

  // The window ends before Trail Launch's flight starts on October 8.
  expect(rows).toEqual([
    { name: 'Autumn Escapes', servedInWindow: '21', videoClicks: '0' },
    { name: 'City Breaks', servedInWindow: '21', videoClicks: '1' },
    { name: 'Retargeting Test', servedInWindow: '0', videoClicks: '0' },
    { name: 'Trail Launch', servedInWindow: '0', videoClicks: '0' },
  ]);
  const idle = await campaign.query({
    select: ['name'],
    compute: { servedInWindow },
    where: { servedInWindow: { eq: '0' } },
  });

  expect(idle.data.map((row) => row.data.name).sort()).toEqual([
    'Retargeting Test',
    'Trail Launch',
  ]);
});

it('withholds reach because device IDs require the privacy role', async () => {
  const runtime = await startSeeded();

  for (const actor of [actors.ana, actors.fin]) {
    const page = await runtime.as(actor).objects.Campaign.query({
      select: ['name'],
      compute: { reach },
      limit: 1,
    });

    expect(page.data[0]!.meta.fields?.reach).toEqual({ status: 'forbidden' });
  }
});

it('rejects click-through rate as one expression today', async () => {
  const runtime = await startSeeded();

  await expect(
    runtime.as(actors.ana).objects.Campaign.query({
      select: ['name'],
      compute: { ctr: clickThroughRate },
    }),
  ).rejects.toMatchObject({
    code: 'invalid-request',
    issues: [{ path: ['compute', 'ctr', 'sql'], problem: 'not-supported' }],
  });
});

// Acceptance test for arithmetic over aggregates. Remove `.fails` and the
// rejection test above when click-through rate is supported.
it.fails('computes click-through rate per campaign', async () => {
  const runtime = await startSeeded();
  const page = await runtime.as(actors.ana).objects.Campaign.query({
    select: ['name'],
    compute: { ctr: clickThroughRate },
    orderBy: [{ field: 'ctr', direction: 'desc' }],
  });

  // Null sorts last: Retargeting Test has served no impressions.
  expect(page.data.map((row) => row.data)).toEqual([
    { name: 'City Breaks', ctr: 0.15 },
    { name: 'Trail Launch', ctr: 0.08 },
    { name: 'Autumn Escapes', ctr: 0.04 },
    { name: 'Retargeting Test', ctr: null },
  ]);
});
