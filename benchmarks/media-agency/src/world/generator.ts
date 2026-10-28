import type { Currency, Delivery, Tier, World } from './model.js';
import { platforms, tiers } from './model.js';

/** Stable integer PRNG; independent of wall clock, locale and Math.random. */
export function rng(seed: number) {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);

    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const dates = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 6, 17 + i)).toISOString().slice(0, 10),
);

export const currencies: Currency[] = ['GBP', 'EUR', 'USD'];

export function fx(date: string, from: Currency, to: Currency) {
  const base = { GBP: 1, EUR: 0.84, USD: 0.76 };
  const day = Number(date.slice(-2));
  const value = (c: Currency) =>
    base[c] * (c === 'GBP' ? 1 : 1 + ((day % 7) - 3) / 1000);

  return value(from) / value(to);
}

/** Compact canonical world. Large fact tables are deterministic iterators, not duplicated arrays. */
export function generateWorld({
  seed,
  tier,
}: {
  seed: number;
  tier: Tier;
}): World {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error('seed must be a uint32');

  const size = tiers[tier];

  if (!size) throw new Error('Unknown tier');

  const random = rng(seed);
  const world: World = {
    version: 1,
    seed,
    tier,
    now: '2026-10-15T13:00:00.000Z',
    clients: [],
    accounts: [],
    campaigns: [],
    lines: [],
    groups: [],
    ads: [],
    invoices: [],
  };

  for (let i = 0; i < size.clients; i++) {
    const code =
      i === 0
        ? 'ACME'
        : i === 1
          ? 'HARBOR'
          : `CLIENT${String(i + 1).padStart(3, '0')}`;
    const client = {
      id: `001${String(i + 1).padStart(12, '0')}`,
      code,
      name:
        i === 0
          ? 'Acme Retail'
          : i === 1
            ? 'Harbor Bank'
            : `Northlight client ${i + 1}`,
      team: i % 2 ? 'finance' : 'retail',
      currency: currencies[i % 3]!,
      feePct: 10 + Math.floor(random() * 900000) / 100000,
    };

    world.clients.push(client);

    for (const [p, platform] of platforms.entries())
      world.accounts.push({
        id: `${platform}-account-${i + 1}`,
        clientId: client.id,
        platform,
        currency: currencies[(i + (i % 4 === 0 ? 1 : 0)) % 3]!,
        timezone: (i + p) % 3 === 0 ? 'America/New_York' : 'Europe/London',
      });
  }

  for (let i = 0; i < size.campaigns; i++) {
    const platform = platforms[i % 4]!;
    const client = world.clients[Math.floor(i / 4) % size.clients]!;
    const account = world.accounts.find(
      (a) => a.clientId === client.id && a.platform === platform,
    )!;
    const ordinal = Math.floor(i / (size.clients * 4));
    const missingLink = i > 7 && random() < 0.08;
    const malformedName = missingLink && random() < 0.375;
    const campaign = {
      id: `${platform}-campaign-${10000 + i}`,
      accountId: account.id,
      platform,
      name: `NL_${malformedName ? client.code.toLowerCase() + 'X' : client.code}_Q4_${ordinal % 2 ? 'RTG' : 'PROSP'}_${platform.toUpperCase()}_${ordinal}`,
      status: (i > 7 && i % 20 === 0
        ? 'ARCHIVED'
        : i % 7 === 6
          ? 'PAUSED'
          : 'ACTIVE') as 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
      budgetMinor: 10000 + Math.floor(random() * 40000),
      budgetId:
        platform === 'google-ads' &&
        ordinal % 5 < 2 &&
        (Math.floor(i / 4) % size.clients) % 3 === 0
          ? `budget-${account.id}-shared`
          : `budget-${i}`,
      flightStart: '2026-10-01',
      flightEnd: i > 7 && i % 23 === 0 ? '2026-10-10' : '2026-10-31',
      missingLink,
      malformedName,
    };
    // A shared Google budget is one value, never two disagreeing campaign values.
    const sibling = world.campaigns.find(
      (c) => c.budgetId === campaign.budgetId,
    );

    if (sibling) campaign.budgetMinor = sibling.budgetMinor;

    world.campaigns.push(campaign);

    if (i % 10 !== 9)
      world.lines.push({
        id: `PL-${i + 1}`,
        clientId: client.id,
        campaignId: campaign.id,
        linkedId: missingLink ? null : campaign.id,
        platform,
        channel:
          platform === 'meta' || platform === 'tiktok'
            ? 'social'
            : platform === 'ttd'
              ? 'programmatic'
              : 'search',
        budgetMinor: campaign.budgetMinor * 31,
        currency: client.currency,
        flightStart: campaign.flightStart,
        flightEnd: campaign.flightEnd,
      });

    for (let g = 0; g < size.groups; g++) {
      const groupId = `${platform}-group-${i}-${g}`;

      world.groups.push({
        id: groupId,
        campaignId: campaign.id,
        name: `${campaign.name}_G${g}`,
        budgetMinor: Math.floor(campaign.budgetMinor / size.groups),
        status: 'ACTIVE',
      });

      for (let a = 0; a < size.ads; a++)
        world.ads.push({
          id: `${platform}-ad-${i}-${g}-${a}`,
          groupId,
          campaignId: campaign.id,
          status: 'ACTIVE',
        });
    }
  }

  // Independent canonical arithmetic: invoices are derived before projection into SQL.
  const september = new Map<string, number>();

  for (const row of delivery(world))
    if (row.date.startsWith('2026-09'))
      september.set(
        row.campaignId,
        (september.get(row.campaignId) ?? 0) + row.spendMicros / 10000,
      );

  for (const [i, c] of world.campaigns.entries()) {
    const account = world.accounts.find((a) => a.id === c.accountId)!;

    world.invoices.push({
      id: `INV-${i + 1}`,
      campaignId: c.id,
      clientId: account.clientId,
      amountMinor: Math.round(
        (september.get(c.id) ?? 0) * (i % 8 === 0 ? 1.08 : 1),
      ),
      currency: account.currency,
      month: '2026-09',
    });
  }

  return world;
}

/** Account-local daily facts. TikTok's projection deliberately stops at October 12. */
export function* delivery(world: World): Generator<Delivery> {
  const accounts = new Map(world.accounts.map((a) => [a.id, a]));
  const campaigns = new Map(world.campaigns.map((c) => [c.id, c]));

  for (const [i, ad] of world.ads.entries()) {
    const c = campaigns.get(ad.campaignId)!;
    const a = accounts.get(c.accountId)!;
    const random = rng(world.seed ^ Math.imul(i + 1, 2654435761));

    for (const date of dates) {
      const spendMinor = 100 + Math.floor(random() * 1600);
      const impressions = spendMinor * (5 + (i % 9));
      const clicks = Math.floor(impressions / (45 + (i % 30)));

      yield {
        adId: ad.id,
        campaignId: c.id,
        platform: c.platform,
        date,
        currency: a.currency,
        spendMicros: spendMinor * 10000,
        impressions,
        clicks,
        conversions: Math.floor(clicks / 15),
      };
    }
  }
}

export function loaded(row: Delivery) {
  return row.date <= (row.platform === 'tiktok' ? '2026-10-12' : '2026-10-14');
}

export function todaySpend(campaignId: string, seed: number) {
  return (
    1000 +
    Math.floor(rng(seed + Number(campaignId.split('-').at(-1)))() * 19000)
  );
}

export function safety(world: World) {
  return world.ads.flatMap((ad, i) =>
    Array.from({ length: 3 }, (_, event) => ({
      id: `BS-${i}-${event}`,
      adId: ad.id,
      campaignId: ad.campaignId,
      severity: (i + event * 7) % 19 === 0 ? 'high' : 'low',
      category: 'unsafe-content',
      observedAt: `2026-10-${String(9 + ((i + event) % 6)).padStart(2, '0')}T10:00:00.000Z`,
    })),
  );
}
