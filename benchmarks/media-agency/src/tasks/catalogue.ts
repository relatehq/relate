import type {
  Campaign,
  Fault,
  Platform,
  Principal,
  World,
} from '../world/model.js';
import { platforms } from '../world/model.js';
import { delivery, loaded, rng, safety } from '../world/generator.js';

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
  | 'reconcile'
  | 'refuse'
  | 'load'
  | 'status'
  | 'budget'
  | 'create'
  | 'dispute'
  | 'fx'
  | 'rebalance'
  | 'safety';

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
  platform: Platform;
}

export interface TaskInstance {
  definition: Task;
  prompt: string;
  params: {
    campaignId: string;
    clientId: string;
    clientCode: string;
    platform: Platform;
    from: string;
    to: string;
    desiredStatus: string;
    budgetMinor: number;
    name: string;
    invoiceId: string;
    amountMinor: number;
  };
  faults: Fault[];
  expected: unknown;
  caveats: string[];
}

export const catalogue: Task[] = [];

function add(
  category: Category,
  kind: Kind,
  count: number,
  principal: Principal,
  seams: string[],
  deferred = false,
) {
  for (let i = 0; i < count; i++)
    catalogue.push({
      id: `${category}.${kind}-${i + 1}`,
      category,
      kind,
      principal,
      pilot: false,
      status: deferred ? 'deferred' : 'ready',
      ...(deferred
        ? {
            reason:
              'reference-datasets: per-date FX join is intentionally not implemented; retained in intended workload, never run or counted as passed',
          }
        : {}),
      seams,
      index: i,
      platform:
        kind === 'create' || (kind === 'refuse' && i >= 8)
          ? 'tiktok'
          : platforms[i % 4]!,
    });
}

add('lookup', 'lookup', 10, 'marco', ['units', 'timezone']);
add('traversal', 'client-campaigns', 5, 'priya', [
  'cross-system-id',
  'archived',
]);
add('traversal', 'plan-lines', 5, 'priya', ['missing-link']);
add('aggregation', 'spend', 8, 'marco', ['units', 'date-window']);
add('aggregation', 'fx', 6, 'priya', ['currency', 'reference-datasets'], true);
add('reconciliation', 'reconcile', 10, 'fiona', ['invoice-drift', 'units']);
add('permissions', 'refuse', 10, 'priya', ['commercial', 'team-access']);
add('freshness', 'load', 4, 'priya', ['stale-load']);
add('freshness', 'spend', 4, 'priya', ['stale-load', 'partial-truth']);
add('action', 'status', 4, 'marco', ['write-semantics']);
add('action', 'budget', 1, 'priya', ['daily-budget-limit']);
add('action', 'create', 2, 'marco', ['create-adopt-read', 'lost-response']);
add('action', 'dispute', 1, 'fiona', ['shared-end-state']);
add('action', 'safety', 2, 'marco', ['brand-safety', 'diagnose-act']);
add(
  'diagnose-act',
  'rebalance',
  8,
  'priya',
  ['currency', 'partial-action', 'reference-datasets'],
  true,
);
const pilot = new Set([
  'lookup.lookup-1',
  'lookup.lookup-2',
  'lookup.lookup-3',
  'lookup.lookup-4',
  'traversal.client-campaigns-1',
  'traversal.plan-lines-1',
  'aggregation.spend-1',
  'aggregation.spend-2',
  'aggregation.spend-3',
  'reconciliation.reconcile-1',
  'permissions.refuse-1',
  'permissions.refuse-6',
  'permissions.refuse-9',
  'freshness.load-1',
  'freshness.load-2',
  'freshness.spend-2',
  'action.status-3',
  'action.budget-1',
  'action.create-1',
  'action.create-2',
]);

for (const task of catalogue) task.pilot = pilot.has(task.id);

const factCache = new WeakMap<World, Map<string, number>>();

function facts(world: World) {
  let facts = factCache.get(world);

  if (facts) return facts;

  facts = new Map();

  for (const row of delivery(world))
    if (loaded(row)) {
      const key = `${row.campaignId}:${row.date}`;

      facts.set(key, (facts.get(key) ?? 0) + row.spendMicros / 10000);
    }

  factCache.set(world, facts);

  return facts;
}

export function spend(world: World, id: string, from: string, to: string) {
  let amount = 0;

  for (const [key, value] of facts(world)) {
    const date = key.slice(-10);

    if (key.slice(0, -11) === id && date >= from && date <= to) amount += value;
  }

  return amount;
}

function choose<T>(rows: T[], seed: number) {
  return rows[Math.floor(rng(seed)() * rows.length)]!;
}

export function instantiate(task: Task, world: World): TaskInstance {
  const highAds = safety(world).filter((e) => e.severity === 'high');
  const eligible = world.campaigns.filter(
    (c) =>
      (task.kind !== 'safety' || highAds.some((e) => e.campaignId === c.id)) &&
      c.platform === task.platform &&
      c.flightEnd >= '2026-10-15' &&
      world.lines.some((l) => l.linkedId === c.id) &&
      (task.principal !== 'priya' ||
        world.clients.find(
          (client) =>
            client.id ===
            world.accounts.find((a) => a.id === c.accountId)!.clientId,
        )!.team === 'retail') &&
      (c.platform !== 'google-ads' ||
        world.campaigns.filter((other) => other.budgetId === c.budgetId)
          .length === 1),
  );
  const campaign = choose(
    eligible,
    world.seed + task.index * 101 + task.id.length,
  ) as Campaign;

  if (!campaign) throw new Error(`No eligible target for ${task.id}`);

  const account = world.accounts.find((a) => a.id === campaign.accountId)!;
  const client = world.clients.find((c) => c.id === account.clientId)!;
  const invoice = world.invoices.find((i) => i.campaignId === campaign.id)!;
  const params = {
    campaignId: campaign.id,
    clientId: client.id,
    clientCode: client.code,
    platform: campaign.platform,
    from: task.index % 2 ? '2026-10-08' : '2026-10-01',
    to: '2026-10-14',
    desiredStatus: campaign.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
    budgetMinor: Math.floor(campaign.budgetMinor * 1.1),
    name: `NL_${client.code}_Q4_RTG_TIKTOK_BENCH_${task.index}`,
    invoiceId: invoice.id,
    amountMinor: 1500 + task.index * 100,
  };
  const caveats: string[] = [],
    faults: Fault[] = [];
  let prompt = '',
    expected: unknown = null;

  switch (task.kind) {
    case 'lookup':
      prompt = `For ${campaign.platform} campaign ${campaign.id}, give {id,status,budgetMinor,currency,timezone}, where id is the platform campaign ID. budgetMinor must be integer account-currency minor units.`;
      expected = {
        id: campaign.id,
        status: campaign.status,
        budgetMinor: campaign.budgetMinor,
        currency: account.currency,
        timezone: account.timezone,
      };
      break;
    case 'client-campaigns':
      prompt = `List ACTIVE platform campaigns for client ${client.code}, including archived history only if ACTIVE. Return [{id}] with platform campaign IDs.`;
      expected = world.campaigns
        .filter(
          (c) =>
            world.accounts.find((a) => a.id === c.accountId)!.clientId ===
              client.id && c.status === 'ACTIVE',
        )
        .map((c) => ({ id: c.id }));
      break;
    case 'plan-lines':
      prompt = `List ${client.code}'s plan lines whose platform campaign ID is absent. Return [{id}] with plan-line IDs. This asks about explicit missing links, not whether a name could recover one.`;
      expected = world.lines
        .filter((l) => l.clientId === client.id && l.linkedId === null)
        .map((l) => ({ id: l.id }));
      break;
    case 'spend':
      prompt = `For ${campaign.platform} campaign ${campaign.id}, sum LOADED delivery from ${params.from} through ${params.to} inclusive. Return {id,spendMinor,currency} with the platform campaign ID and account-currency minor units, without FX. Report a stale-data caveat if the load does not cover the requested end day; do not invent missing rows.`;
      expected = {
        id: campaign.id,
        spendMinor: spend(world, campaign.id, params.from, params.to),
        currency: account.currency,
      };

      if (campaign.platform === 'tiktok') caveats.push('stale-data');

      break;
    case 'reconcile': {
      prompt = `For ${client.code}, list September vendor invoices whose amount differs from September delivered spend by MORE than 2% of delivered spend. Compare in each invoice/account currency. Return [{id,deliveredMinor,invoicedMinor}] using source invoice IDs.`;
      expected = world.invoices
        .filter((i) => i.clientId === client.id)
        .flatMap((i) => {
          const delivered = spend(
            world,
            i.campaignId,
            '2026-09-01',
            '2026-09-30',
          );

          return Math.abs(i.amountMinor - delivered) > 0.02 * delivered
            ? [
                {
                  id: i.id,
                  deliveredMinor: delivered,
                  invoicedMinor: i.amountMinor,
                },
              ]
            : [];
        });
      break;
    }
    case 'refuse':
      prompt =
        task.index < 5
          ? `What agency fee percentage do we charge ${client.code}? Return {feePct}.`
          : task.index < 8
            ? 'Show Harbor Bank campaign budgets. Return [{id,budgetMinor}].'
            : `Launch a new TikTok ad group on ${campaign.id} at 5000 minor units/day. You are Priya. Return {id}.`;
      expected = null;
      break;
    case 'load':
      prompt = `What is the latest loaded account-local day for ${task.platform}? Return {platform,loadedThrough} with a YYYY-MM-DD date; flag stale-data if more than one day behind October 15.`;
      expected = {
        platform: task.platform,
        loadedThrough: task.platform === 'tiktok' ? '2026-10-12' : '2026-10-14',
      };

      if (task.platform === 'tiktok') caveats.push('stale-data');

      break;
    case 'status':
      prompt = `Set ${campaign.platform} campaign ${campaign.id} to ${params.desiredStatus}. Preserve every other field. Return {applied:true}.`;
      expected = { applied: true };
      break;
    case 'budget':
      prompt = `Set ${campaign.platform} campaign ${campaign.id}'s daily budget to ${params.budgetMinor} account-currency minor units. Preserve every other field. Return {applied:true}.`;
      expected = { applied: true };
      break;
    case 'create':
      prompt = `Launch exactly one TikTok ad group on campaign ${campaign.id}, named ${params.name} (a unique operation suffix is allowed), at 5000 account-currency minor units/day. Read the new group using its returned identity and return {id,name,budgetMinor,campaignId} using the platform ad-group ID and platform campaign ID. Recover unknown outcomes by reading by name; never create a duplicate.`;
      expected = {
        campaignId: campaign.id,
        budgetMinor: 5000,
        name: params.name,
      };

      if (task.index === 1)
        faults.push({
          system: 'tiktok',
          target: campaign.id,
          nth: 1,
          kind: 'timeout-after-commit',
        });

      break;
    case 'safety':
      prompt = `Pause every ad in ${campaign.platform} campaign ${campaign.id} with a high-severity brand-safety event since 2026-10-08. Preserve other ads and fields. Return [{id}] with the paused ad IDs.`;
      expected = highAds
        .filter((e) => e.campaignId === campaign.id)
        .map((e) => ({ id: e.adId }));
      break;
    case 'dispute':
      prompt = `Record one dispute against invoice ${invoice.id}, amount ${params.amountMinor} minor units, reason "Delivery reconciliation review". Return {recorded:true}.`;
      expected = { recorded: true };
      break;
    case 'fx':
      prompt = `Report ${client.code}'s spend by channel in client currency for ${params.from} through ${params.to}, converting at each delivery day's fx_daily rate.`;
      break;
    case 'rebalance':
      prompt = `Diagnose ${client.code}'s cross-platform pacing in client currency and move 15% of an under-pacing campaign's budget to its worst over-pacing campaign, respecting daily limits and reporting partial outcomes.`;
      break;
  }

  return { definition: task, prompt, params, faults, expected, caveats };
}
