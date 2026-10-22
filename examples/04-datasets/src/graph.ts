import { z } from 'zod';
import {
  computed,
  defineAccess,
  defineDataset,
  defineGraph,
  defineObject,
  defineRelationship,
  defineSource,
  from,
  objectId,
  reference,
  source,
} from 'relate';

const access = defineAccess({
  roles: ['employee', 'account-manager', 'finance', 'privacy'],
  fieldGroups: ['ordinary', 'financial', 'identifying'],
  claims: { team: z.string() },
});
const { ordinary, financial, identifying } = access.groups;
const timestamp = z.iso.datetime({ offset: true, precision: 3 });

// Salesforce owns advertisers as Accounts; Team__c is a custom field.
export const salesforceAccounts = defineSource({
  id: 'salesforce.accounts',
  idField: 'Id',
  schema: z.object({
    Id: z.string(),
    IsDeleted: z.boolean(),
    Name: z.string(),
    Industry: z.string().nullable(),
    Team__c: z.string(),
  }),
});

// The ad server's SQLite database owns campaigns. It knows advertisers by Account ID.
export const adServerCampaigns = defineSource({
  id: 'adserver.campaigns',
  idField: 'id',
  schema: z.object({
    id: z.string(),
    advertiser_id: z.string(),
    name: z.string(),
    status: z.string(),
    budget_minor: z.number(),
    flight_start: timestamp,
    flight_end: timestamp,
  }),
});

// DuckDB holds the delivery log. Rows have no Relate identity: one row per served ad.
export const Impressions = defineDataset({
  id: 'adserver.impressions',
  description: 'One row per ad impression served.',
  columns: {
    campaignId: {
      id: 'adserver.impressions.campaign-id',
      schema: z.string(),
      access: ordinary,
    },
    servedAt: {
      id: 'adserver.impressions.served-at',
      schema: timestamp,
      access: ordinary,
    },
    placement: {
      id: 'adserver.impressions.placement',
      description: 'Where the ad ran: homepage, article or video.',
      schema: z.string(),
      access: ordinary,
    },
    clicked: {
      id: 'adserver.impressions.clicked',
      description: 'Whether the viewer clicked this impression.',
      schema: z.boolean(),
      access: ordinary,
    },
    costMicros: {
      id: 'adserver.impressions.cost-micros',
      description: 'Media cost of this impression in millionths of a dollar.',
      schema: z.int64(),
      access: financial,
    },
    deviceId: {
      id: 'adserver.impressions.device-id',
      description: 'Device that saw the ad; null when consent was not given.',
      schema: z.string().nullable(),
      access: identifying,
    },
  },
});

export const Advertiser = defineObject({
  id: 'adnetwork.advertiser',
  label: 'Advertiser',
  membership: source(salesforceAccounts),
  properties: {
    id: objectId({ id: 'adnetwork.advertiser.id', access: ordinary }),
    name: from(salesforceAccounts.fields.Name, {
      id: 'adnetwork.advertiser.name',
      access: ordinary,
    }),
    industry: from(salesforceAccounts.fields.Industry, {
      id: 'adnetwork.advertiser.industry',
      access: ordinary,
    }),
    team: from(salesforceAccounts.fields.Team__c, {
      id: 'adnetwork.advertiser.team',
      access: ordinary,
    }),
  },
});

export const Campaign = defineObject({
  id: 'adnetwork.campaign',
  label: 'Campaign',
  membership: source(adServerCampaigns),
  properties: {
    id: objectId({ id: 'adnetwork.campaign.id', access: ordinary }),
    externalId: from(adServerCampaigns.fields.id, {
      id: 'adnetwork.campaign.external-id',
      access: ordinary,
    }),
    // The ad server's Account ID becomes the Advertiser's own object ID.
    advertiser: reference(Advertiser, {
      id: 'adnetwork.campaign.advertiser',
      access: ordinary,
      from: adServerCampaigns.fields.advertiser_id,
    }),
    name: from(adServerCampaigns.fields.name, {
      id: 'adnetwork.campaign.name',
      access: ordinary,
    }),
    status: from(adServerCampaigns.fields.status, {
      id: 'adnetwork.campaign.status',
      access: ordinary,
    }),
    budgetMinor: from(adServerCampaigns.fields.budget_minor, {
      id: 'adnetwork.campaign.budget-minor',
      access: financial,
    }),
    flightStart: from(adServerCampaigns.fields.flight_start, {
      id: 'adnetwork.campaign.flight-start',
      access: ordinary,
    }),
    flightEnd: from(adServerCampaigns.fields.flight_end, {
      id: 'adnetwork.campaign.flight-end',
      access: ordinary,
    }),
    // Declared calculations: reusable names with stable IDs, computed in DuckDB.
    served: computed({
      id: 'adnetwork.campaign.served',
      access: ordinary,
      sql: 'SELECT COUNT(*) FROM self.impressions',
    }),
    clicks: computed({
      id: 'adnetwork.campaign.clicks',
      access: ordinary,
      sql: 'SELECT COUNT(*) FROM self.impressions i WHERE i.clicked = TRUE',
    }),
    spendMicros: computed({
      id: 'adnetwork.campaign.spend-micros',
      access: financial,
      sql: 'SELECT COALESCE(SUM(i.costMicros), 0) FROM self.impressions i',
    }),
  },
  datasets: {
    impressions: {
      id: 'adnetwork.campaign.impressions',
      dataset: Impressions,
      on: [{ column: 'campaignId', property: 'externalId' }],
    },
  },
});

export const AdvertiserCampaigns = defineRelationship({
  id: 'adnetwork.advertiser-campaigns',
  forward: 'campaigns',
  reverse: 'advertiser',
  via: Campaign.properties.advertiser,
});

export const graph = defineGraph({
  id: 'ad-network',
  access,
  objects: { Advertiser, Campaign },
  relationships: { AdvertiserCampaigns },
  datasets: { Impressions },
  policies: {
    Advertiser: {
      read: {
        gate: access.role('employee'),
        evidenceMaxAgeMs: 60_000,
        where: { team: { eq: access.claims.team } },
      },
    },
    Campaign: {
      read: {
        gate: access.role('employee'),
        evidenceMaxAgeMs: 60_000,
        where: { advertiser: { team: { eq: access.claims.team } } },
      },
      groups: { financial: access.role('finance') },
      datasets: { impressions: { gate: access.role('employee') } },
    },
    Impressions: {
      groups: {
        financial: access.role('finance'),
        identifying: access.role('privacy'),
      },
    },
  },
  // Development principals for `relate dev`; a production host authenticates them.
  principals: {
    ana: {
      roles: ['employee', 'account-manager'],
      claims: { team: 'emea' },
    },
    fin: {
      roles: ['employee', 'finance'],
      claims: { team: 'emea' },
    },
  },
});

export const actors = {
  ana: { id: 'ana', ...graph.principals.ana },
  fin: { id: 'fin', ...graph.principals.fin },
};
