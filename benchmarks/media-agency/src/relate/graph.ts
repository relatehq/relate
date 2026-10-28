import { z } from 'zod';
import {
  computed,
  defineAccess,
  defineAction,
  defineDataset,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  native,
  nativeMembership,
  objectId,
  reference,
  referenceInput,
  source,
} from 'relate';
import type { Principal } from '../world/model.js';

const access = defineAccess({
  roles: ['reader', 'media', 'finance', 'activation-lead'],
  fieldGroups: ['ordinary', 'commercial'],
  claims: { team: z.string() },
});
const { ordinary, commercial } = access.groups;

export const clients = defineSource({
  id: 'crm.accounts',
  idField: 'Id',
  schema: z.object({
    Id: z.string(),
    Name: z.string(),
    Client_Code__c: z.string(),
    Team__c: z.string(),
    CurrencyIsoCode: z.string(),
    Fee_Pct__c: z.number(),
    IsDeleted: z.boolean(),
  }),
});

export const accounts = defineSource({
  id: 'plans.accounts',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    sf_account_id: z.string(),
    platform: z.string(),
  }),
});

export const lines = defineSource({
  id: 'plans.lines',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    sf_account_id: z.string(),
    client_code: z.string(),
    platform: z.string(),
    channel: z.string(),
    budget_minor: z.number(),
    currency: z.string(),
    flight_start: z.string(),
    flight_end: z.string(),
    platform_campaign_id: z.string().nullable(),
  }),
});

export const invoices = defineSource({
  id: 'finance.invoices',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    sf_account_id: z.string(),
    campaign_id: z.string(),
    amount_minor: z.number(),
    currency: z.string(),
    month: z.string(),
  }),
});

export const loads = defineSource({
  id: 'warehouse.loads',
  idField: 'platform',
  schema: z.object({ platform: z.string(), loaded_through: z.string() }),
});

export const Client = defineObject({
  id: 'agency.client',
  membership: source(clients),
  properties: {
    id: objectId({ id: 'client.id' }),
    externalId: from(clients.fields.Id, { id: 'client.external' }),
    code: from(clients.fields.Client_Code__c, { id: 'client.code' }),
    name: from(clients.fields.Name, { id: 'client.name' }),
    team: from(clients.fields.Team__c, { id: 'client.team' }),
    currency: from(clients.fields.CurrencyIsoCode, { id: 'client.currency' }),
    feePct: from(clients.fields.Fee_Pct__c, {
      id: 'client.fee',
      access: commercial,
    }),
  },
});

export const Account = defineObject({
  id: 'agency.account',
  membership: source(accounts),
  properties: {
    id: objectId({ id: 'account.id' }),
    externalId: from(accounts.fields.id, { id: 'account.external' }),
    client: reference(Client, {
      id: 'account.client',
      from: accounts.fields.sf_account_id,
    }),
    platform: from(accounts.fields.platform, { id: 'account.platform' }),
  },
});

export const Delivery = defineDataset({
  id: 'warehouse.delivery',
  description:
    'Campaign delivery by account-local calendar date; spendMicros is account currency, NOT client currency. TikTok may be stale; inspect loadedThrough or Load.',
  columns: {
    campaignId: {
      id: 'delivery.campaign',
      schema: z.string(),
      access: ordinary,
    },
    date: { id: 'delivery.date', schema: z.iso.date(), access: ordinary },
    currency: { id: 'delivery.currency', schema: z.string(), access: ordinary },
    spendMicros: { id: 'delivery.spend', schema: z.int64(), access: ordinary },
    impressions: {
      id: 'delivery.impressions',
      schema: z.int64(),
      access: ordinary,
    },
    clicks: { id: 'delivery.clicks', schema: z.int64(), access: ordinary },
    conversions: {
      id: 'delivery.conversions',
      schema: z.int64(),
      access: ordinary,
    },
  },
});

export const BrandSafety = defineDataset({
  id: 'warehouse.safety',
  columns: {
    adId: { id: 'safety.ad', schema: z.string(), access: ordinary },
    severity: { id: 'safety.severity', schema: z.string(), access: ordinary },
    observedAt: { id: 'safety.observed', schema: z.string(), access: ordinary },
  },
});

export const SiteConversions = defineDataset({
  id: 'warehouse.conversions',
  columns: {
    campaignId: {
      id: 'conversions.campaign',
      schema: z.string(),
      access: ordinary,
    },
    date: { id: 'conversions.date', schema: z.iso.date(), access: ordinary },
    conversions: {
      id: 'conversions.count',
      schema: z.int64(),
      access: ordinary,
    },
    revenueMinor: {
      id: 'conversions.revenue',
      schema: z.int64(),
      access: ordinary,
    },
  },
});

export function platformObjects<const P extends string>(platform: P) {
  const schema = z.object({
    id: z.string(),
    account_id: z.string(),
    campaign_id: z.string(),
    name: z.string(),
    status: z.string(),
    budget_minor: z.number(),
    currency: z.string(),
    timezone: z.string(),
    budget_id: z.string(),
    spend_today_minor: z.number(),
  });
  const campaigns = defineSource({
    id: `${platform}.campaigns`,
    idField: 'id',
    schema,
  });
  const adgroups = defineSource({
    id: `${platform}.groups`,
    idField: 'id',
    schema,
  });
  const ads = defineSource({ id: `${platform}.ads`, idField: 'id', schema });
  const properties = (s: typeof campaigns, prefix: string) => ({
    id: objectId({ id: `${prefix}.id` }),
    externalId: from(s.fields.id, { id: `${prefix}.external` }),
    account: reference(Account, {
      id: `${prefix}.account`,
      from: s.fields.account_id,
    }),
    name: from(s.fields.name, { id: `${prefix}.name` }),
    status: from(s.fields.status, { id: `${prefix}.status` }),
    budgetMinor: from(s.fields.budget_minor, { id: `${prefix}.budget` }),
    accountCurrency: from(s.fields.currency, { id: `${prefix}.currency` }),
    accountTimezone: from(s.fields.timezone, { id: `${prefix}.timezone` }),
    budgetId: from(s.fields.budget_id, { id: `${prefix}.budget-id` }),
    spendTodayMinor: from(s.fields.spend_today_minor, {
      id: `${prefix}.today`,
      description:
        'Partial account-local today, in account currency minor units.',
    }),
  });
  const Campaign = defineObject({
    id: `${platform}.campaign`,
    membership: source(campaigns),
    properties: {
      ...properties(campaigns, `${platform}.campaign`),
      spendAccountMinor: computed({
        id: `${platform}.spend`,
        sql: "SELECT SUM(spendMicros) / 10000.0 FROM self.delivery WHERE date >= '2026-10-01'",
        description:
          'Loaded October spend in ACCOUNT currency minor units; no FX conversion.',
      }),
      loadedThrough: computed({
        id: `${platform}.loaded`,
        sql: 'SELECT MAX(date) FROM self.delivery',
      }),
    },
    datasets: {
      delivery: {
        id: `${platform}.delivery`,
        dataset: Delivery,
        on: [{ column: 'campaignId', property: 'externalId' }],
      },
      conversions: {
        id: `${platform}.conversions`,
        dataset: SiteConversions,
        on: [{ column: 'campaignId', property: 'externalId' }],
      },
    },
  });
  const AdGroup = defineObject({
    id: `${platform}.group`,
    membership: source(adgroups),
    properties: {
      ...properties(adgroups, `${platform}.group`),
      campaign: reference(Campaign, {
        id: `${platform}.group.campaign`,
        from: adgroups.fields.campaign_id,
      }),
    },
  });
  const Ad = defineObject({
    id: `${platform}.ad`,
    membership: source(ads),
    properties: {
      ...properties(ads, `${platform}.ad`),
      campaign: reference(Campaign, {
        id: `${platform}.ad.campaign`,
        from: ads.fields.campaign_id,
      }),
      highSeverityEvents: computed({
        id: `${platform}.ad.high`,
        sql: "SELECT COUNT(*) FROM self.brandSafety WHERE severity = 'high' AND observedAt >= '2026-10-08'",
      }),
    },
    datasets: {
      brandSafety: {
        id: `${platform}.ad.safety`,
        dataset: BrandSafety,
        on: [{ column: 'adId', property: 'externalId' }],
      },
    },
  });

  return { campaigns, adgroups, ads, Campaign, AdGroup, Ad };
}

export const meta = platformObjects('meta'),
  tiktok = platformObjects('tiktok'),
  ttd = platformObjects('ttd'),
  google = platformObjects('google-ads');

export const PlanLine = defineObject({
  id: 'agency.line',
  membership: source(lines),
  properties: {
    id: objectId({ id: 'line.id' }),
    externalId: from(lines.fields.id, { id: 'line.external' }),
    client: reference(Client, {
      id: 'line.client',
      from: lines.fields.sf_account_id,
    }),
    platform: from(lines.fields.platform, { id: 'line.platform' }),
    platformCampaignId: from(lines.fields.platform_campaign_id, {
      id: 'line.campaign',
    }),
    channel: from(lines.fields.channel, { id: 'line.channel' }),
    budgetMinor: from(lines.fields.budget_minor, { id: 'line.budget' }),
    currency: from(lines.fields.currency, { id: 'line.currency' }),
    flightStart: from(lines.fields.flight_start, { id: 'line.start' }),
    flightEnd: from(lines.fields.flight_end, { id: 'line.end' }),
  },
});

export const VendorInvoice = defineObject({
  id: 'agency.invoice',
  membership: source(invoices),
  properties: {
    id: objectId({ id: 'invoice.id' }),
    externalId: from(invoices.fields.id, { id: 'invoice.external' }),
    client: reference(Client, {
      id: 'invoice.client',
      from: invoices.fields.sf_account_id,
    }),
    campaignId: from(invoices.fields.campaign_id, { id: 'invoice.campaign' }),
    amountMinor: from(invoices.fields.amount_minor, {
      id: 'invoice.amount',
      access: commercial,
    }),
    currency: from(invoices.fields.currency, { id: 'invoice.currency' }),
    month: from(invoices.fields.month, { id: 'invoice.month' }),
  },
});

export const Load = defineObject({
  id: 'agency.load',
  membership: source(loads),
  properties: {
    id: objectId({ id: 'load.id' }),
    platform: from(loads.fields.platform, { id: 'load.platform' }),
    loadedThrough: from(loads.fields.loaded_through, { id: 'load.through' }),
  },
});

export const MediaChange = defineObject({
  id: 'agency.change',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'change.id' }),
    actorId: native(z.string(), { id: 'change.actor' }),
    kind: native(z.string(), { id: 'change.kind' }),
    externalId: native(z.string(), { id: 'change.external' }),
    detail: native(z.string(), { id: 'change.detail' }),
  },
});

export const ChangeMedia = defineAction({
  id: 'agency.change-media',
  description:
    'Change campaign/ad status or absolute daily campaign budget. Rejects ended or unlinked plans, shared Google budgets, and planner changes outside 20% of day-start budget.',
  input: z.object({
    platform: z.string(),
    entity: z.string(),
    externalId: z.string(),
    status: z.string().optional(),
    budgetMinor: z.number().optional(),
  }),
  output: z.object({ applied: z.boolean() }),
  creates: [MediaChange],
  errors: {
    rejected: z.object({ reason: z.string() }),
    unresolved: z.object({ reason: z.string() }),
  },
  policy: { execute: access.role('media') },
});

export const LaunchAdGroup = defineAction({
  id: 'agency.launch-group',
  description:
    'Create a TikTok ad group, recover lost responses by its unique name, adopt inside the action, and return its Relate ID for a follow-up read. Activation lead only.',
  input: z.object({
    campaign: referenceInput(tiktok.Campaign),
    name: z.string().min(1),
    budgetMinor: z.number(),
  }),
  output: z.object({ adGroupId: referenceInput(tiktok.AdGroup) }),
  creates: [MediaChange],
  adopts: [tiktok.AdGroup],
  errors: {
    rejected: z.object({ reason: z.string() }),
    unresolved: z.object({ reason: z.string() }),
  },
  policy: { execute: access.role('activation-lead') },
});

export const RecordDispute = defineAction({
  id: 'agency.dispute',
  input: z.object({
    invoice: referenceInput(VendorInvoice),
    reason: z.string().min(1),
    amountMinor: z.number(),
  }),
  output: z.object({ recorded: z.boolean() }),
  creates: [MediaChange],
  policy: { execute: access.role('finance') },
});

/** Fixed policy variants because current SDK gates do not express role-dependent OR rules. */
export function createGraph(principal: Principal) {
  const scope =
    principal === 'priya' ? { team: { eq: access.claims.team } } : undefined;
  const read = (where?: object) =>
    where
      ? { gate: access.role('reader'), where, evidenceMaxAgeMs: 60000 }
      : { gate: access.role('reader') };
  const platformPolicy = {
    read: read(scope ? { account: { client: scope } } : undefined),
    datasets: {
      delivery: { gate: access.role('reader') },
      conversions: { gate: access.role('reader') },
    },
  };
  const groupPolicy = {
    read: read(scope ? { account: { client: scope } } : undefined),
  };
  const adPolicy = {
    ...groupPolicy,
    datasets: { brandSafety: { gate: access.role('reader') } },
  };

  return defineGraph({
    id: 'northlight-agency',
    access,
    objects: {
      Client,
      Account,
      PlanLine,
      VendorInvoice,
      Load,
      MediaChange,
      MetaCampaign: meta.Campaign,
      TikTokCampaign: tiktok.Campaign,
      TtdCampaign: ttd.Campaign,
      GadsCampaign: google.Campaign,
      MetaAdSet: meta.AdGroup,
      TikTokAdGroup: tiktok.AdGroup,
      TtdAdGroup: ttd.AdGroup,
      GadsAdGroup: google.AdGroup,
      MetaAd: meta.Ad,
      TikTokAd: tiktok.Ad,
      TtdAd: ttd.Ad,
      GadsAd: google.Ad,
    },
    datasets: { Delivery, BrandSafety, SiteConversions },
    actions: {
      changeMedia: ChangeMedia,
      launchAdGroup: LaunchAdGroup,
      recordInvoiceDispute: RecordDispute,
    },
    relationships: {
      ClientAccounts: defineRelationship({
        id: 'client.accounts',
        forward: 'accounts',
        reverse: 'client',
        via: Account.properties.client,
      }),
      ClientLines: defineRelationship({
        id: 'client.lines',
        forward: 'planLines',
        reverse: 'client',
        via: PlanLine.properties.client,
      }),
      TikTokGroups: defineRelationship({
        id: 'tiktok.campaign-groups',
        forward: 'adGroups',
        reverse: 'campaign',
        via: tiktok.AdGroup.properties.campaign,
      }),
    },
    policies: {
      Client: {
        read: read(scope),
        groups: { commercial: access.role('finance') },
      },
      Account: { read: read(scope ? { client: scope } : undefined) },
      PlanLine: { read: read(scope ? { client: scope } : undefined) },
      VendorInvoice: {
        read: { gate: access.role('finance') },
        groups: { commercial: access.role('finance') },
      },
      Load: { read: read() },
      MediaChange: {
        read: {
          gate: access.role('reader'),
          where: { actorId: { eq: access.actor.id } },
          evidenceMaxAgeMs: 60000,
        },
        create: { gate: access.role('reader') },
      },
      MetaCampaign: platformPolicy,
      TikTokCampaign: platformPolicy,
      TtdCampaign: platformPolicy,
      GadsCampaign: platformPolicy,
      MetaAdSet: groupPolicy,
      TikTokAdGroup: groupPolicy,
      TtdAdGroup: groupPolicy,
      GadsAdGroup: groupPolicy,
      MetaAd: adPolicy,
      TikTokAd: adPolicy,
      TtdAd: adPolicy,
      GadsAd: adPolicy,
      Delivery: {},
      BrandSafety: {},
      SiteConversions: {},
    },
  });
}
