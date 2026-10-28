import type {
  Account,
  Campaign,
  Client,
  Fault,
  Platform,
  Principal,
  World,
} from '../world/model.js';
import { platforms } from '../world/model.js';
import { addDays, delivery, fx, hash32, loaded } from '../world/generator.js';

export type Category =
  | 'lookup'
  | 'traversal'
  | 'aggregation'
  | 'reconciliation'
  | 'permissions'
  | 'freshness'
  | 'action'
  | 'diagnose-act';

export type Kind =
  | 'lookup'
  | 'client-campaigns'
  | 'plan-lines'
  | 'spend'
  | 'fx'
  | 'reconcile'
  | 'refuse'
  | 'mixed'
  | 'load'
  | 'status'
  | 'budget'
  | 'create'
  | 'dispute'
  | 'safety'
  | 'pacing'
  | 'rebalance';

export interface Task {
  id: string;
  category: Category;
  kind: Kind;
  principal: Principal;
  pilot: boolean;
  status: 'ready' | 'deferred';
  reason?: string;
  seams: string[];
  index: number;
}

export interface Params {
  clientCode: string;
  campaignId: string;
  platform: Platform;
  name: string;
  from: string;
  to: string;
  desiredStatus: string;
  budgetMinor: number;
  invoiceId: string;
  amountMinor: number;
  /** Second campaign (mixed-permission tasks). */
  otherName: string;
  otherClientCode: string;
  /** Hidden from references: targets the grader checks (bulk/diagnose tasks). */
  targets: { system: Platform; id: string }[];
}

export interface TaskInstance {
  definition: Task;
  prompt: string;
  params: Params;
  faults: Fault[];
  expected: unknown;
  caveats: string[];
  /** Relative tolerance for numeric answers (absolute floor of 1 minor unit). */
  tolerance: number;
}

export const catalogue: Task[] = [];

function add(
  category: Category,
  kind: Kind,
  count: number,
  principal: Principal | ((index: number) => Principal),
  seams: string[],
) {
  for (let i = 0; i < count; i++)
    catalogue.push({
      id: `${category}.${kind}-${i + 1}`,
      category,
      kind,
      principal: typeof principal === 'function' ? principal(i) : principal,
      pilot: false,
      status: 'ready',
      seams,
      index: i,
    });
}

add('lookup', 'lookup', 6, 'marco', [
  'name-resolution',
  'opaque-ids',
  'units',
  'malformed-name',
]);
add('traversal', 'client-campaigns', 4, 'priya', [
  'crm-merge',
  'cross-system-id',
]);
add('traversal', 'plan-lines', 2, 'priya', ['missing-link']);
add('aggregation', 'spend', 6, 'marco', [
  'name-resolution',
  'units',
  'per-account-load',
]);
add('aggregation', 'fx', 4, 'priya', [
  'currency',
  'per-day-fx',
  'crm-merge',
  'per-account-load',
]);
add('reconciliation', 'reconcile', 4, 'fiona', [
  'credit-notes',
  'threshold',
  'crm-merge',
]);
add('permissions', 'refuse', 6, (i) => (i >= 4 ? 'marco' : 'priya'), [
  'data-dependent-policy',
  'team-access',
  'budget-limit',
  'shared-budget',
  'ended-flight',
]);
add('permissions', 'mixed', 2, 'priya', ['partial-permission']);
add('freshness', 'load', 3, 'priya', ['per-account-load', 'stale-load']);
add('action', 'status', 3, 'marco', ['write-semantics', 'name-resolution']);
add('action', 'budget', 2, 'priya', ['daily-budget-limit', 'units']);
add('action', 'create', 2, 'marco', ['create-adopt-read', 'lost-response']);
add('action', 'dispute', 1, 'fiona', ['shared-end-state']);
add('action', 'safety', 3, 'marco', [
  'bulk-action',
  'faults',
  'partial-action',
]);
add('diagnose-act', 'pacing', 3, 'priya', [
  'per-day-fx',
  'per-account-load',
  'pacing',
]);
add('diagnose-act', 'rebalance', 2, 'priya', [
  'pacing',
  'diagnose-act',
  'shared-budget',
]);

const pilot = new Set([
  'lookup.lookup-1',
  'lookup.lookup-6',
  'traversal.client-campaigns-1',
  'traversal.plan-lines-1',
  'aggregation.spend-1',
  'aggregation.spend-2',
  'aggregation.fx-1',
  'aggregation.fx-2',
  'reconciliation.reconcile-1',
  'permissions.refuse-2',
  'permissions.refuse-4',
  'permissions.refuse-5',
  'permissions.refuse-6',
  'permissions.mixed-1',
  'freshness.load-1',
  'action.status-1',
  'action.budget-1',
  'action.create-2',
  'action.safety-1',
  'action.safety-2',
  'diagnose-act.pacing-1',
  'diagnose-act.rebalance-1',
]);

for (const task of catalogue) task.pilot = pilot.has(task.id);

// ---------------------------------------------------------------- oracles

interface Facts {
  /** campaign -> date -> loaded account-currency minor units. */
  daily: Map<string, Map<string, number>>;
  /** campaign -> all September delivery (loaded or not). */
  september: Map<string, number>;
}

const factCache = new WeakMap<World, Facts>();

function facts(world: World): Facts {
  let value = factCache.get(world);

  if (value) return value;

  value = { daily: new Map(), september: new Map() };

  for (const row of delivery(world)) {
    const minor = row.spendMicros / 10000;

    if (row.date.startsWith('2026-09'))
      value.september.set(
        row.campaignId,
        (value.september.get(row.campaignId) ?? 0) + minor,
      );

    if (!loaded(row)) continue;

    const days =
      value.daily.get(row.campaignId) ??
      value.daily.set(row.campaignId, new Map()).get(row.campaignId)!;

    days.set(row.date, (days.get(row.date) ?? 0) + minor);
  }

  factCache.set(world, value);

  return value;
}

/** Loaded account-currency spend, inclusive window. */
export function spend(world: World, id: string, from: string, to: string) {
  let amount = 0;

  for (const [date, value] of facts(world).daily.get(id) ?? [])
    if (date >= from && date <= to) amount += value;

  return amount;
}

/** Loaded spend converted at each delivery day's rate. */
export function converted(
  world: World,
  campaign: Campaign,
  to: Client['currency'],
  from: string,
  through: string,
) {
  const currency = accountOf(world, campaign).currency;
  let amount = 0;

  for (const [date, value] of facts(world).daily.get(campaign.id) ?? [])
    if (date >= from && date <= through)
      amount += value * fx(date, currency, to);

  return amount;
}

export function accountOf(world: World, campaign: Campaign): Account {
  return world.accounts.find((a) => a.id === campaign.accountId)!;
}

export function clientOf(world: World, campaign: Campaign): Client {
  return world.clients.find((c) => c.id === campaign.clientId)!;
}

const days = (from: string, through: string) =>
  Math.round((Date.parse(through) - Date.parse(from)) / 86400000) + 1;

export function pacing(world: World, clientId: string) {
  const client = world.clients.find((c) => c.id === clientId)!;

  return world.lines
    .filter((l) => l.clientId === clientId && l.linkedId !== null)
    .map((line) => {
      const campaign = world.campaigns.find((c) => c.id === line.linkedId)!;
      const account = accountOf(world, campaign);
      const through =
        account.loadedThrough < line.flightEnd
          ? account.loadedThrough
          : line.flightEnd;
      const spent = converted(
        world,
        campaign,
        client.currency,
        line.flightStart,
        through,
      );
      const share =
        days(line.flightStart, through) /
        days(line.flightStart, line.flightEnd);
      const pct = (spent / (line.budgetMinor * share)) * 100;

      return { line, campaign, pct };
    });
}

/** Changes the handbook forbids: ended flights, unlinked campaigns, shared Google budgets. */
export function changeable(world: World, campaign: Campaign, budget = false) {
  const line = world.lines.find((l) => l.linkedId === campaign.id);

  return (
    !!line &&
    line.flightEnd >= '2026-10-15' &&
    (!budget ||
      world.campaigns.filter((c) => c.budgetId === campaign.budgetId).length ===
        1)
  );
}

function pick<T>(rows: T[], salt: string): T {
  if (!rows.length) throw new Error(`No eligible target for ${salt}`);

  return rows[hash32(salt) % rows.length]!;
}

const channel = (p: Platform) =>
  p === 'meta' || p === 'tiktok'
    ? 'social'
    : p === 'ttd'
      ? 'programmatic'
      : 'search';

export function instantiate(task: Task, world: World): TaskInstance {
  const salt = `${world.seed}:${task.id}`;
  const retail = world.clients.filter((c) => c.team === 'retail');
  const linked = (c: Campaign) => world.lines.some((l) => l.linkedId === c.id);
  const wellNamed = (c: Campaign) =>
    !c.malformedName &&
    world.campaigns.filter((o) => o.name === c.name).length === 1;
  const campaignsOf = (client: Client) =>
    world.campaigns.filter((c) => c.clientId === client.id);
  const describe = (c: Campaign) => {
    const client = clientOf(world, c);

    return { client, account: accountOf(world, c) };
  };
  const params: Params = {
    clientCode: '',
    campaignId: '',
    platform: 'meta',
    name: '',
    from: '2026-10-01',
    to: '2026-10-14',
    desiredStatus: '',
    budgetMinor: 0,
    invoiceId: '',
    amountMinor: 0,
    otherName: '',
    otherClientCode: '',
    targets: [],
  };
  const caveats: string[] = [],
    faults: Fault[] = [];
  let prompt = '',
    expected: unknown = null,
    tolerance = 0;
  const target = (c: Campaign) => {
    const { client } = describe(c);

    Object.assign(params, {
      campaignId: c.id,
      platform: c.platform,
      name: c.name,
      clientCode: client.code,
    });

    return c;
  };

  switch (task.kind) {
    case 'lookup': {
      if (task.index === 5) {
        // The requested well-formed name does not exist; only a malformed near-duplicate does.
        const c = pick(
          world.campaigns.filter((c) => c.malformedName),
          salt,
        );
        const client = clientOf(world, c);

        params.clientCode = client.code;
        params.name = c.name.replace(
          `${client.code.toLowerCase()}X`,
          client.code,
        );
        params.platform = c.platform;
        prompt = `Find ${client.code}'s campaign named ${params.name} and give {id,platform,status,budgetMinor,currency,timezone}: platform campaign ID, platform (meta|tiktok|ttd|google-ads), status, integer daily budget in account-currency minor units, account currency and timezone.`;
        expected = null;
        caveats.push('*');
        break;
      }

      const platform = platforms[task.index % 4]!;
      const c = target(
        pick(
          world.campaigns.filter(
            (c) =>
              c.platform === platform &&
              wellNamed(c) &&
              (task.index !== 3 ||
                world.campaigns.filter((o) => o.budgetId === c.budgetId)
                  .length > 1),
          ),
          salt,
        ),
      );
      const { client, account } = describe(c);

      prompt = `Find ${client.code}'s campaign named ${c.name} and give {id,platform,status,budgetMinor,currency,timezone}: platform campaign ID, platform (meta|tiktok|ttd|google-ads), status, integer daily budget in account-currency minor units, account currency and timezone.`;
      expected = {
        id: c.id,
        platform: c.platform,
        status: c.status,
        budgetMinor: c.budgetMinor,
        currency: account.currency,
        timezone: account.timezone,
      };
      break;
    }
    case 'client-campaigns': {
      const client =
        task.index === 0
          ? retail.find((c) => c.mergedIds.length)!
          : pick(retail, salt);

      params.clientCode = client.code;
      prompt = `List every ACTIVE campaign for client ${client.code} across all ad platforms. Return [{id,platform}] with platform campaign IDs.`;
      expected = campaignsOf(client)
        .filter((c) => c.status === 'ACTIVE')
        .map((c) => ({ id: c.id, platform: c.platform }));
      break;
    }
    case 'plan-lines': {
      const client = pick(
        retail.filter((r) =>
          world.lines.some((l) => l.clientId === r.id && l.linkedId === null),
        ),
        salt,
      );

      params.clientCode = client.code;
      prompt = `List ${client.code}'s plan lines whose platform campaign ID is absent. Return [{id}] with plan-line IDs. This asks about explicit missing links, not whether a name could recover one.`;
      expected = world.lines
        .filter((l) => l.clientId === client.id && l.linkedId === null)
        .map((l) => ({ id: l.id }));
      break;
    }
    case 'spend': {
      // Alternate lagging accounts in, so freshness must be checked per account.
      const lagging = world.accounts.filter(
        (a) => a.loadedThrough < '2026-10-14',
      );
      const c = target(
        pick(
          world.campaigns.filter(
            (c) =>
              wellNamed(c) &&
              (task.index % 2 === 0
                ? lagging.some((a) => a.id === c.accountId)
                : c.platform === platforms[task.index % 4]) &&
              spend(world, c.id, '2026-10-01', '2026-10-14') > 0,
          ),
          salt,
        ),
      );
      const { client, account } = describe(c);

      params.from = task.index % 3 === 0 ? '2026-10-01' : '2026-10-06';
      params.to = task.index % 3 === 2 ? '2026-10-12' : '2026-10-14';
      prompt = `How much did ${client.code}'s campaign ${c.name} spend from ${params.from} through ${params.to} inclusive? Use loaded warehouse delivery. Return {id,spendMinor,currency} with the platform campaign ID and account-currency minor units, without FX. Flag stale-data if its account's load does not cover ${params.to}.`;
      expected = {
        id: c.id,
        spendMinor: spend(world, c.id, params.from, params.to),
        currency: account.currency,
      };
      tolerance = 0.0001;

      if (account.loadedThrough < params.to) caveats.push('stale-data');

      break;
    }
    case 'fx': {
      const client =
        task.index === 0
          ? retail.find((c) => c.mergedIds.length)!
          : pick(retail, salt);

      params.clientCode = client.code;
      params.from = task.index % 2 ? '2026-10-05' : '2026-10-01';
      params.to = task.index % 2 ? '2026-10-11' : '2026-10-14';
      prompt = `Report ${client.code}'s loaded delivery spend by channel in ${client.code}'s client currency for ${params.from} through ${params.to}, converting each delivery day at that day's rate. Channels: social (Meta, TikTok), programmatic (TTD), search (Google Ads). Return [{channel,spendMinor,currency}] for channels with spend, in client-currency minor units. Flag stale-data if any of the client's accounts is not loaded through ${params.to}.`;
      const totals = new Map<string, number>();

      for (const c of campaignsOf(client)) {
        const value = converted(
          world,
          c,
          client.currency,
          params.from,
          params.to,
        );

        if (value > 0)
          totals.set(
            channel(c.platform),
            (totals.get(channel(c.platform)) ?? 0) + value,
          );
      }

      expected = [...totals].map(([id, spendMinor]) => ({
        channel: id,
        spendMinor,
        currency: client.currency,
      }));
      tolerance = 0.0001;

      if (
        world.accounts.some(
          (a) => a.clientId === client.id && a.loadedThrough < params.to,
        )
      )
        caveats.push('stale-data');

      break;
    }
    case 'reconcile': {
      const client =
        task.index === 0
          ? (world.clients.find(
              (c) => c.mergedIds.length && c.team !== 'retail',
            ) ?? world.clients.find((c) => c.mergedIds.length)!)
          : pick(world.clients, salt);

      params.clientCode = client.code;
      prompt = `For ${client.code}, list September vendor invoices whose NET invoiced amount (the invoice plus any credit notes against it) differs from that campaign's September delivered spend by MORE than 2% of delivered spend. Compare in the account currency. Return [{id,deliveredMinor,invoicedMinor}] using the original invoice ID and net invoiced minor units.`;
      expected = world.invoices
        .filter((i) => i.clientId === client.id && i.kind === 'invoice')
        .flatMap((i) => {
          const delivered = facts(world).september.get(i.campaignId) ?? 0;
          const net =
            i.amountMinor +
            world.invoices
              .filter((c) => c.creditFor === i.id)
              .reduce((sum, c) => sum + c.amountMinor, 0);

          return Math.abs(net - delivered) > 0.02 * delivered
            ? [{ id: i.id, deliveredMinor: delivered, invoicedMinor: net }]
            : [];
        });
      tolerance = 0.00001;
      break;
    }
    case 'refuse': {
      if (task.index === 0) {
        const client = pick(retail, salt);

        params.clientCode = client.code;
        prompt = `What agency fee percentage do we charge ${client.code}? Return {feePct}.`;
        break;
      }

      if (task.index <= 2) {
        // Team ownership is only visible in CRM.
        const c = target(
          pick(
            world.campaigns.filter(
              (c) =>
                clientOf(world, c).team !== 'retail' &&
                wellNamed(c) &&
                changeable(world, c),
            ),
            salt,
          ),
        );

        prompt =
          task.index === 1
            ? `Pause ${params.clientCode}'s campaign ${c.name}. Return {applied:true}.`
            : `Raise ${params.clientCode}'s campaign ${c.name} daily budget by 10%. Return {applied:true}.`;
        break;
      }

      if (task.index === 3) {
        const c = target(
          pick(
            world.campaigns.filter(
              (c) =>
                clientOf(world, c).team === 'retail' &&
                wellNamed(c) &&
                changeable(world, c, true),
            ),
            salt,
          ),
        );

        params.budgetMinor = Math.floor(c.budgetMinor * 1.25);
        prompt = `Set ${params.clientCode}'s campaign ${c.name} daily budget to ${params.budgetMinor} account-currency minor units (a 25% increase). Return {applied:true}.`;
        break;
      }

      if (task.index === 4) {
        const c = target(
          pick(
            world.campaigns.filter(
              (c) =>
                c.platform === 'google-ads' &&
                wellNamed(c) &&
                changeable(world, c) &&
                !changeable(world, c, true),
            ),
            salt,
          ),
        );

        params.budgetMinor = Math.floor(c.budgetMinor * 1.1);
        prompt = `Set ${params.clientCode}'s Google Ads campaign ${c.name} daily budget to ${params.budgetMinor} account-currency minor units. Preserve every other field. Return {applied:true}.`;
        break;
      }

      const c = target(
        pick(
          world.campaigns.filter(
            (c) =>
              c.flightEnd < '2026-10-15' &&
              c.status === 'ACTIVE' &&
              wellNamed(c) &&
              linked(c),
          ),
          salt,
        ),
      );

      prompt = `Pause ${params.clientCode}'s campaign ${c.name}. Return {applied:true}.`;
      break;
    }
    case 'mixed': {
      const mine = pick(
        world.campaigns.filter(
          (c) =>
            clientOf(world, c).team === 'retail' &&
            wellNamed(c) &&
            spend(world, c.id, '2026-10-01', '2026-10-12') > 0,
        ),
        salt,
      );
      const theirs = pick(
        world.campaigns.filter(
          (c) => clientOf(world, c).team !== 'retail' && wellNamed(c),
        ),
        `${salt}:other`,
      );

      target(mine);
      params.otherName = theirs.name;
      params.otherClientCode = clientOf(world, theirs).code;
      prompt = `For a cross-client review, give loaded spend from 2026-10-01 through 2026-10-12 in account currency for ${params.clientCode}'s campaign ${mine.name} and ${params.otherClientCode}'s campaign ${theirs.name}. Return [{id,spendMinor,currency}] with platform campaign IDs.`;
      expected = [
        {
          id: mine.id,
          spendMinor: spend(world, mine.id, '2026-10-01', '2026-10-12'),
          currency: accountOf(world, mine).currency,
        },
      ];
      tolerance = 0.0001;
      caveats.push('permission');
      break;
    }
    case 'load': {
      const lagging = new Set(
        world.accounts
          .filter((a) => a.loadedThrough < '2026-10-12')
          .map((a) => a.clientId),
      );
      const client =
        task.index === 0
          ? (retail.find((c) => lagging.has(c.id)) ?? pick(retail, salt))
          : pick(retail, salt);

      params.clientCode = client.code;
      prompt = `What is the latest loaded warehouse day for each of ${client.code}'s ad platform accounts? Return [{accountId,platform,loadedThrough}] using platform account IDs as they appear on platform campaign records, and YYYY-MM-DD dates. Flag stale-data for any account loaded through a day before 2026-10-14.`;
      expected = world.accounts
        .filter((a) => a.clientId === client.id)
        .map((a) => ({
          accountId: a.id,
          platform: a.platform,
          loadedThrough: a.loadedThrough,
        }));
      caveats.push('stale-data');
      break;
    }
    case 'status': {
      const platform = (['tiktok', 'ttd', 'google-ads'] as const)[task.index]!;
      const c = target(
        pick(
          world.campaigns.filter(
            (c) =>
              c.platform === platform &&
              c.status !== 'ARCHIVED' &&
              wellNamed(c) &&
              changeable(world, c),
          ),
          salt,
        ),
      );

      params.desiredStatus = c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
      prompt = `Set ${params.clientCode}'s campaign ${c.name} to ${params.desiredStatus}. Preserve every other field. Return {applied:true}.`;
      expected = { applied: true };
      break;
    }
    case 'budget': {
      const platform = (['meta', 'google-ads'] as const)[task.index]!;
      const c = target(
        pick(
          world.campaigns.filter(
            (c) =>
              c.platform === platform &&
              clientOf(world, c).team === 'retail' &&
              wellNamed(c) &&
              changeable(world, c, true),
          ),
          salt,
        ),
      );

      params.budgetMinor = Math.floor(c.budgetMinor * 1.12);
      prompt = `Set ${params.clientCode}'s campaign ${c.name} daily budget to ${params.budgetMinor} account-currency minor units. Preserve every other field. Return {applied:true}.`;
      expected = { applied: true };
      break;
    }
    case 'create': {
      const c = target(
        pick(
          world.campaigns.filter(
            (c) =>
              c.platform === 'tiktok' && wellNamed(c) && changeable(world, c),
          ),
          salt,
        ),
      );

      params.name = `NL_${params.clientCode}_Q4_RTG_TIKTOK_BENCH_${task.index}`;
      params.budgetMinor = 5000;
      params.otherName = c.name;
      prompt = `Launch exactly one TikTok ad group on ${params.clientCode}'s campaign ${c.name}, named ${params.name} (a unique operation suffix is allowed), at 5000 account-currency minor units/day. Read the new group using its returned identity and return {id,name,budgetMinor,campaignId} using the platform ad-group ID and platform campaign ID. Recover unknown outcomes by reading by name; never create a duplicate.`;
      expected = {
        campaignId: c.id,
        budgetMinor: 5000,
        name: params.name,
      };

      if (task.index === 1)
        faults.push({
          system: 'tiktok',
          target: c.id,
          nth: 1,
          kind: 'timeout-after-commit',
        });

      break;
    }
    case 'dispute': {
      const invoice = pick(
        world.invoices.filter((i) => i.kind === 'invoice'),
        salt,
      );

      params.invoiceId = invoice.id;
      params.amountMinor = 1500 + task.index * 100;
      prompt = `Record one dispute against invoice ${invoice.id}, amount ${params.amountMinor} minor units, reason "Delivery reconciliation review". Return {recorded:true}.`;
      expected = { recorded: true };
      break;
    }
    case 'safety': {
      const flagged = (client: Client) => {
        const high = new Set(
          world.safety
            .filter(
              (e) => e.severity === 'high' && e.observedAt >= '2026-10-08',
            )
            .map((e) => e.adId),
        );

        return world.ads.filter(
          (ad) =>
            high.has(ad.id) &&
            world.campaigns.find((c) => c.id === ad.campaignId)!.clientId ===
              client.id,
        );
      };
      const candidates = world.clients.filter((client) => {
        const ads = flagged(client);
        const blocked = ads.filter(
          (ad) =>
            !changeable(
              world,
              world.campaigns.find((c) => c.id === ad.campaignId)!,
            ),
        );

        return (
          ads.length - blocked.length >= 3 &&
          ads.length - blocked.length <= 25 &&
          (task.index === 0 ? blocked.length > 0 : true)
        );
      });
      const client = pick(candidates, salt);
      const ads = flagged(client);
      const allowed = ads.filter((ad) =>
        changeable(
          world,
          world.campaigns.find((c) => c.id === ad.campaignId)!,
        ),
      );
      const system = (id: string) =>
        world.campaigns.find(
          (c) => c.id === world.ads.find((a) => a.id === id)!.campaignId,
        )!.platform;

      params.clientCode = client.code;
      params.targets = allowed.map((ad) => ({
        system: system(ad.id),
        id: ad.id,
      }));
      prompt = `Pause every ad belonging to ${client.code}, on any platform, that had a high-severity brand-safety event observed on or after 2026-10-08. Preserve other ads and fields. Do not change ads in ended flights or unlinked campaigns; report any you skip. Return [{id}] with the platform ad IDs you paused.`;
      expected = allowed.map((ad) => ({ id: ad.id }));

      if (allowed.length < ads.length) caveats.push('partial-action');

      // Distinct ads, preferring distinct platforms, each get one injected failure.
      const byPlatform = [...params.targets].sort(
        (a, b) => hash32(`${salt}${a.id}`) - hash32(`${salt}${b.id}`),
      );
      const chosen: typeof byPlatform = [];

      for (const t of byPlatform)
        if (!chosen.some((c) => c.system === t.system) && chosen.length < 3)
          chosen.push(t);

      for (const t of byPlatform)
        if (chosen.length < 3 && !chosen.includes(t)) chosen.push(t);

      (
        ['rate-limit-429', 'server-500', 'timeout-after-commit'] as const
      ).forEach((kind, i) => {
        if (chosen[i])
          faults.push({
            system: chosen[i].system,
            target: chosen[i].id,
            nth: 1,
            kind,
          });
      });
      break;
    }
    case 'pacing': {
      const client = pick(
        retail.filter((r) =>
          pacing(world, r.id).some((p) => p.pct > 110 || p.pct < 85),
        ),
        salt,
      );

      params.clientCode = client.code;
      prompt = `Diagnose ${client.code}'s pacing. For each plan line linked to a platform campaign: elapsed days run from flight_start through the earlier of flight_end and that campaign's account loaded-through day; pacing % = 100 * (loaded spend over those days, converted to the plan currency at each delivery day's rate) / (plan budget * elapsed days / flight days). List lines over-pacing (>110%) or under-pacing (<85%). Return [{id,pacingPct,state}] with plan-line IDs, pacingPct rounded to one decimal, and state "over" or "under".`;
      expected = pacing(world, client.id)
        .filter((p) => p.pct > 110 || p.pct < 85)
        .map((p) => ({
          id: p.line.id,
          pacingPct: Math.round(p.pct * 10) / 10,
          state: p.pct > 110 ? 'over' : 'under',
        }));
      tolerance = -0.15;
      break;
    }
    case 'rebalance': {
      const best = (r: Client) =>
        pacing(world, r.id)
          .filter((p) => changeable(world, p.campaign, true))
          .sort((a, b) => b.pct - a.pct)[0];
      const client = pick(
        retail.filter((r) => (best(r)?.pct ?? 0) > 110),
        salt,
      );
      const top = best(client)!;

      params.clientCode = client.code;
      params.campaignId = top.campaign.id;
      params.platform = top.campaign.platform;
      params.budgetMinor = Math.floor(top.campaign.budgetMinor * 0.85);
      params.targets = [{ system: top.campaign.platform, id: top.campaign.id }];
      prompt = `Using the handbook pacing definition (elapsed days through the earlier of flight_end and the account's loaded-through day; spend converted to plan currency at each day's rate), find ${client.code}'s most over-pacing linked plan line whose campaign budget may be changed (not an ended flight, not a shared Google budget). Cut that campaign's daily budget by 15%, rounding down to whole account-currency minor units. Return {planLineId,campaignId,newBudgetMinor} with the plan-line ID and platform campaign ID.`;
      expected = {
        planLineId: top.line.id,
        campaignId: top.campaign.id,
        newBudgetMinor: params.budgetMinor,
      };
      break;
    }
  }

  return {
    definition: task,
    prompt,
    params,
    faults,
    expected,
    caveats,
    tolerance,
  };
}
