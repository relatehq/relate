import { z } from 'zod';
import {
  bind,
  computed,
  defineAccess,
  defineAction,
  defineApp,
  defineDataset,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
  referenceInput,
} from 'relate';
import { datafusion } from '@relate/connector-datafusion';
import { sqlite } from '@relate/connector-sqlite';

const access = defineAccess({
  roles: ['reader', 'analyst', 'editor'],
  fieldGroups: ['ordinary'],
  claims: {},
});
const Events = defineDataset({
  id: 'delivery.events',
  columns: {
    campaignId: {
      id: 'delivery.campaign',
      schema: z.string().nullable(),
      access: access.groups.ordinary,
    },
    costMicros: {
      id: 'delivery.cost',
      schema: z.int64().nullable(),
      access: access.groups.ordinary,
    },
  },
});
const Budgets = defineDataset({
  id: 'budgets',
  columns: {
    campaignId: {
      id: 'budget.campaign',
      schema: z.string(),
      access: access.groups.ordinary,
    },
    amountMicros: {
      id: 'budget.amount',
      schema: z.int64(),
      access: access.groups.ordinary,
    },
  },
});
const Campaign = defineObject({
  id: 'campaign',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'campaign.id' }),
    externalId: native(z.string(), { id: 'campaign.external' }),
    name: native(z.string(), { id: 'campaign.name' }),
    spend: computed({
      id: 'campaign.spend',
      sql: 'SELECT SUM(costMicros) FROM self.events',
    }),
    budget: computed({
      id: 'campaign.budget',
      sql: 'SELECT SUM(amountMicros) FROM self.budgets',
    }),
  },
  datasets: {
    events: {
      id: 'campaign.events',
      dataset: Events,
      on: [{ column: 'campaignId', property: 'externalId' }],
    },
    budgets: {
      id: 'campaign.budgets',
      dataset: Budgets,
      on: [{ column: 'campaignId', property: 'externalId' }],
    },
  },
});
const AddCampaign = defineAction({
  id: 'campaign.add',
  input: z.object({ externalId: z.string(), name: z.string() }),
  output: z.object({ campaignId: referenceInput(Campaign) }),
  creates: [Campaign],
  policy: { execute: access.role('editor') },
});

export const graph = defineGraph({
  id: 'datafusion-demo',
  access,
  objects: { Campaign },
  datasets: { Events, Budgets },
  actions: { addCampaign: AddCampaign },
  policies: {
    Campaign: {
      read: { gate: access.role('reader') },
      create: { gate: access.role('editor') },
      datasets: {
        events: { gate: access.role('analyst') },
        budgets: { gate: access.role('analyst') },
      },
    },
    Events: {},
    Budgets: {},
  },
});

const addCampaign = implementAction(
  graph,
  AddCampaign,
  async ({ input, objects }) => ({
    campaignId: (await objects.Campaign.create(input)).id,
  }),
);

export function createApp(
  endpoint: string,
  databasePath: string,
  bucket: string,
) {
  return defineApp({
    graph,
    setup({ onDispose }) {
      const lake = datafusion({ connectionId: 'delivery-lake' });
      const budgets = sqlite({ connectionId: 'budgets', path: databasePath });

      onDispose(() => lake.close());
      onDispose(() => budgets.close());

      return {
        actionImplementations: [addCampaign],
        bindings: [
          bind(
            Events,
            lake.parquet(`s3://${bucket}/delivery.parquet`, {
              s3: {
                bucket,
                region: 'us-east-1',
                endpoint,
                accessKeyId: 'local',
                secretAccessKey: 'local',
                allowHttp: true,
              },
            }),
          ),
          bind(Budgets, budgets.table('budgets')),
        ],
      };
    },
  });
}
