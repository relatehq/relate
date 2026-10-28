import type {
  Account,
  Campaign,
  Currency,
  Delivery,
  Platform,
  SafetyEvent,
  Tier,
  World,
} from './model.js';
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

/** Stable 32-bit string hash for per-record derivations. */
export function hash32(value: string) {
  let h = 2166136261;

  for (let i = 0; i < value.length; i++)
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);

  return h >>> 0;
}

export const dates = Array.from({ length: 90 }, (_, i) =>
  new Date(Date.UTC(2026, 6, 17 + i)).toISOString().slice(0, 10),
);

export const currencies: Currency[] = ['GBP', 'EUR', 'USD'];

const dayIndex = new Map(dates.map((d, i) => [d, i]));
const october = dayIndex.get('2026-10-01')!;

export function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86400000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Daily rate: amount_to = amount_from * fx(date, from, to). Rates drift several
 * percent across the window and move day to day, so converting a summed total at
 * one rate is measurably wrong.
 */
export function fx(date: string, from: Currency, to: Currency) {
  const index =
    dayIndex.get(date) ??
    Math.round((Date.parse(date) - Date.parse(dates[0]!)) / 86400000);
  const value = (c: Currency) => {
    if (c === 'GBP') return 1;

    const base = c === 'EUR' ? 0.84 : 0.76;
    const drift = c === 'EUR' ? 0.05 : -0.06;
    const noise = ((hash32(`${c}:${index}`) % 2001) - 1000) / 1000;

    return base * (1 + (drift * (index - 45)) / 45 + noise * 0.012);
  };

  return value(from) / value(to);
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

function ids(random: () => number) {
  const used = new Set<string>();
  const unique = (make: () => string) => {
    for (;;) {
      const value = make();

      if (!used.has(value)) {
        used.add(value);

        return value;
      }
    }
  };
  const digits = (n: number) =>
    String(1 + Math.floor(random() * 9)) +
    Array.from({ length: n - 1 }, () => Math.floor(random() * 10)).join('');
  const alnum = (n: number) =>
    Array.from(
      { length: n },
      () => alphabet[Math.floor(random() * alphabet.length)],
    ).join('');

  return {
    crm: () =>
      unique(
        () =>
          `001Hn0000${Array.from({ length: 9 }, () => {
            const c = alphabet[Math.floor(random() * alphabet.length)]!;

            return random() < 0.5 ? c.toUpperCase() : c;
          }).join('')}`,
      ),
    account: (platform: Platform) =>
      unique(() =>
        platform === 'meta'
          ? digits(15)
          : platform === 'tiktok'
            ? '7' + digits(18)
            : platform === 'ttd'
              ? alnum(7)
              : digits(10),
      ),
    record: (platform: Platform, entity: 'campaign' | 'adgroup' | 'ad') =>
      unique(() =>
        platform === 'meta'
          ? '1202' + digits(14)
          : platform === 'tiktok'
            ? (entity === 'campaign'
                ? '18'
                : entity === 'adgroup'
                  ? '17'
                  : '16') + digits(17)
            : platform === 'ttd'
              ? alnum(entity === 'campaign' ? 7 : 8)
              : digits(
                  entity === 'campaign' ? 11 : entity === 'adgroup' ? 12 : 13,
                ),
      ),
    number: (prefix: string, n: number) => unique(() => prefix + digits(n)),
  };
}

const timezones = ['Europe/London', 'America/New_York', 'Europe/Berlin'];

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
  const make = ids(rng(seed ^ 0x9e3779b9));
  const world: World = {
    version: 2,
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
    safety: [],
  };
  const merged = new Set([0, 2 + Math.floor(random() * (size.clients - 2))]);

  merged.add(
    2 + ((Math.floor(random() * (size.clients - 2)) + 1) % (size.clients - 2)),
  );

  for (let i = 0; i < size.clients; i++) {
    const code =
      i === 0
        ? 'ACME'
        : i === 1
          ? 'HARBOR'
          : `CLIENT${String(i + 1).padStart(3, '0')}`;
    const client = {
      id: make.crm(),
      mergedIds: merged.has(i) ? [make.crm()] : [],
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

    for (const [p, platform] of platforms.entries()) {
      const id = make.account(platform);
      const viaDuplicate = client.mergedIds.length > 0 && p % 2 === 1;

      world.accounts.push({
        id,
        linkId:
          platform === 'google-ads'
            ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}`
            : id,
        clientId: client.id,
        linkedSfId: viaDuplicate ? client.mergedIds[0]! : client.id,
        platform,
        currency:
          random() < 0.3
            ? currencies[(i + 1 + Math.floor(random() * 2)) % 3]!
            : client.currency,
        timezone: timezones[Math.floor(random() * timezones.length)]!,
        loadedThrough: platform === 'tiktok' ? '2026-10-12' : '2026-10-14',
      });
    }
  }

  // A few accounts lag their platform: freshness is per account, not per platform.
  const tiktokAccounts = world.accounts.filter((a) => a.platform === 'tiktok');
  const metaAccounts = world.accounts.filter((a) => a.platform === 'meta');

  tiktokAccounts[Math.floor(random() * tiktokAccounts.length)]!.loadedThrough =
    '2026-10-11';
  metaAccounts[Math.floor(random() * metaAccounts.length)]!.loadedThrough =
    '2026-10-13';

  const ordinals = new Map<string, number>();

  for (let i = 0; i < size.campaigns; i++) {
    const platform = platforms[i % 4]!;
    // Clients own different numbers of campaigns; IDs reveal nothing about ownership.
    const client =
      world.clients[
        i < size.clients * 4
          ? Math.floor(i / 4)
          : Math.floor(Math.pow(random(), 1.4) * size.clients)
      ]!;
    const account = world.accounts.find(
      (a) => a.clientId === client.id && a.platform === platform,
    )!;
    const key = `${client.code}:${platform}`;
    const ordinal = ordinals.get(key) ?? 0;

    ordinals.set(key, ordinal + 1);
    const missingLink = i >= size.clients * 4 && random() < 0.08;
    const malformedName = missingLink && random() < 0.375;
    const statusDraw = random();
    const status: Campaign['status'] =
      i >= size.clients * 4 && statusDraw < 0.05
        ? 'ARCHIVED'
        : statusDraw < 0.19
          ? 'PAUSED'
          : 'ACTIVE';
    const ended = status !== 'ARCHIVED' && random() < 0.07;
    const launch =
      status === 'ACTIVE' && !ended && random() < 0.08
        ? '2026-10-06'
        : dates[0]!;
    const flightEnd = ended ? '2026-10-10' : '2026-10-31';
    const lastDelivery =
      status === 'ARCHIVED'
        ? '2026-09-20'
        : status === 'PAUSED'
          ? `2026-10-${String(3 + Math.floor(random() * 9)).padStart(2, '0')}`
          : ended
            ? flightEnd
            : dates.at(-1)!;
    const id = make.record(platform, 'campaign');
    const campaign: Campaign = {
      id,
      accountId: account.id,
      clientId: client.id,
      platform,
      name: `NL_${malformedName ? client.code.toLowerCase() + 'X' : client.code}_Q4_${ordinal % 2 ? 'RTG' : 'PROSP'}_${platform.toUpperCase()}_${ordinal}`,
      status,
      budgetMinor: 0,
      budgetId: id,
      flightStart: '2026-10-01',
      flightEnd,
      launch,
      lastDelivery,
      trend: Math.round((random() * 1.2 - 0.6) * 1000) / 1000,
      missingLink,
      malformedName,
    };

    if (platform === 'google-ads') {
      // Some Google campaigns share one budget object with a sibling.
      const pool = world.campaigns.filter(
        (c) =>
          c.accountId === account.id &&
          world.campaigns.filter((o) => o.budgetId === c.budgetId).length < 2,
      );

      campaign.budgetId =
        pool.length && random() < 0.22
          ? pool[Math.floor(random() * pool.length)]!.budgetId
          : make.number('9', 10);
    }

    world.campaigns.push(campaign);

    for (let g = 0; g < size.groups; g++) {
      const groupId = make.record(platform, 'adgroup');

      world.groups.push({
        id: groupId,
        campaignId: campaign.id,
        name: `${campaign.name}_G${g}`,
        budgetMinor: 0,
        status: 'ACTIVE',
      });

      for (let a = 0; a < size.ads; a++)
        world.ads.push({
          id: make.record(platform, 'ad'),
          groupId,
          campaignId: campaign.id,
          status: 'ACTIVE',
          stoppedFrom:
            random() < 0.1
              ? `2026-10-${String(2 + Math.floor(random() * 12)).padStart(2, '0')}`
              : null,
        });
    }
  }

  // Independent canonical arithmetic: budgets and invoices derive from facts.
  const september = new Map<string, number>(),
    septemberDays = new Map<string, Set<string>>();

  for (const row of delivery(world))
    if (row.date.startsWith('2026-09')) {
      september.set(
        row.campaignId,
        (september.get(row.campaignId) ?? 0) + row.spendMicros / 10000,
      );
      (
        septemberDays.get(row.campaignId) ??
        septemberDays.set(row.campaignId, new Set()).get(row.campaignId)!
      ).add(row.date);
    }

  const accounts = new Map(world.accounts.map((a) => [a.id, a]));
  const clients = new Map(world.clients.map((c) => [c.id, c]));
  const averageDaily = (c: Campaign) =>
    (september.get(c.id) ?? 0) /
      Math.max(1, septemberDays.get(c.id)?.size ?? 0) ||
    950 * size.groups * size.ads;

  for (const c of world.campaigns) {
    const sibling = world.campaigns.find(
      (o) => o.budgetId === c.budgetId && o.budgetMinor > 0,
    );

    c.budgetMinor =
      sibling?.budgetMinor ??
      Math.round(averageDaily(c) * (0.9 + random() * 0.4));

    for (const g of world.groups.filter((g) => g.campaignId === c.id))
      g.budgetMinor = Math.floor(c.budgetMinor / size.groups);
  }

  for (const [i, c] of world.campaigns.entries()) {
    const account = accounts.get(c.accountId)!;
    const client = clients.get(c.clientId)!;

    if (i % 10 !== 9)
      world.lines.push({
        id: make.number('PL-', 6),
        clientId: client.id,
        campaignId: c.id,
        linkedId: c.missingLink ? null : c.id,
        platform: c.platform,
        channel:
          c.platform === 'meta' || c.platform === 'tiktok'
            ? 'social'
            : c.platform === 'ttd'
              ? 'programmatic'
              : 'search',
        // Flight budget in client currency; deliberately not the platform daily budget.
        budgetMinor: Math.round(
          averageDaily(c) *
            31 *
            (0.7 + random() * 0.65) *
            fx('2026-10-01', account.currency, client.currency),
        ),
        currency: client.currency,
        flightStart: c.flightStart,
        flightEnd: c.flightEnd,
      });

    const delivered = september.get(c.id);

    if (!delivered) continue;

    const draw = random();
    // Most invoices carry small vendor noise; some drift, some sit at the threshold.
    const error =
      draw < 0.7
        ? (random() * 2 - 1) * 0.018
        : draw < 0.8
          ? (random() < 0.5 ? -1 : 1) * (0.0185 + random() * 0.001)
          : draw < 0.86
            ? (random() < 0.5 ? -1 : 1) * (0.0205 + random() * 0.002)
            : (random() < 0.5 ? -1 : 1) * (0.03 + random() * 0.09);
    const net = Math.round(delivered * (1 + error));
    const credit =
      random() < 0.12 ? Math.round(delivered * (0.03 + random() * 0.07)) : 0;
    const invoiceId = make.number('VI-2026-09-', 5);

    world.invoices.push({
      id: invoiceId,
      kind: 'invoice',
      creditFor: null,
      campaignId: c.id,
      clientId: client.id,
      sfAccountId: account.linkedSfId,
      amountMinor: net + credit,
      currency: account.currency,
      month: '2026-09',
    });

    if (credit)
      world.invoices.push({
        id: make.number('VC-2026-09-', 5),
        kind: 'credit',
        creditFor: invoiceId,
        campaignId: c.id,
        clientId: client.id,
        sfAccountId: account.linkedSfId,
        amountMinor: -credit,
        currency: account.currency,
        month: '2026-09',
      });
  }

  let event = 0;

  for (const ad of world.ads)
    for (let e = 0; e < 3; e++)
      world.safety.push({
        id: `BS-${String(++event).padStart(7, '0')}`,
        adId: ad.id,
        campaignId: ad.campaignId,
        severity: random() < 0.035 ? 'high' : 'low',
        category: random() < 0.5 ? 'unsafe-content' : 'adjacency',
        observedAt: `2026-10-${String(1 + Math.floor(random() * 14)).padStart(2, '0')}T${String(Math.floor(random() * 24)).padStart(2, '0')}:00:00.000Z`,
      });

  return world;
}

/** Account-local daily facts, including days the warehouse has not loaded. */
export function* delivery(world: World): Generator<Delivery> {
  const accounts = new Map<string, Account>(
    world.accounts.map((a) => [a.id, a]),
  );
  const campaigns = new Map(world.campaigns.map((c) => [c.id, c]));

  for (const [i, ad] of world.ads.entries()) {
    const c = campaigns.get(ad.campaignId)!;
    const a = accounts.get(c.accountId)!;
    const random = rng(world.seed ^ Math.imul(i + 1, 2654435761));
    const base = 100 + Math.floor(random() * 1600);

    for (const [d, date] of dates.entries()) {
      const noise = random();

      if (
        date < c.launch ||
        date > c.lastDelivery ||
        (ad.stoppedFrom !== null && date >= ad.stoppedFrom)
      )
        continue;

      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      const factor =
        Math.max(0.2, 1 + (d >= october ? (c.trend * (d - october)) / 14 : 0)) *
        (weekday === 0 || weekday === 6 ? 0.85 : 1) *
        (0.75 + noise * 0.5);
      const spendMicros = Math.max(
        10000,
        Math.round(base * factor * 10000 + noise * 9999),
      );
      const spendMinor = spendMicros / 10000;
      const impressions = Math.round(spendMinor * (5 + (i % 9)));
      const clicks = Math.floor(impressions / (45 + (i % 30)));

      yield {
        adId: ad.id,
        campaignId: c.id,
        accountId: a.id,
        platform: c.platform,
        date,
        currency: a.currency,
        loadedThrough: a.loadedThrough,
        spendMicros,
        impressions,
        clicks,
        conversions: Math.floor(clicks / 15),
      };
    }
  }
}

export function loaded(row: Delivery) {
  return row.date <= row.loadedThrough;
}

export function todaySpend(campaignId: string, seed: number) {
  return 1000 + Math.floor(rng(seed + hash32(campaignId))() * 19000);
}

export function safety(world: World): SafetyEvent[] {
  return world.safety;
}
