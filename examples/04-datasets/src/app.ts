import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DuckDBInstance } from '@duckdb/node-api';
import { duckdb } from '@relate/connector-duckdb';
import { sqlite } from '@relate/connector-sqlite';
import { bind, defineApp } from 'relate';
import type { AppSetupContext } from 'relate';
import {
  adServerCampaigns,
  graph,
  Impressions,
  salesforceAccounts,
} from './graph.js';
import { campaigns, impressions, salesforceOrgId } from './data.js';
import { simulatedSalesforce } from './salesforce.js';

function writeCampaigns(path: string) {
  const db = new DatabaseSync(path);

  try {
    db.exec(
      'CREATE TABLE campaigns(id TEXT PRIMARY KEY, advertiser_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, budget_minor INTEGER NOT NULL, flight_start TEXT NOT NULL, flight_end TEXT NOT NULL)',
    );
    const insert = db.prepare(
      'INSERT INTO campaigns VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    for (const row of campaigns) insert.run(...row);
  } finally {
    db.close();
  }
}

/** The connector reads existing files only, so the writer closes before it opens. */
async function writeImpressions(path: string) {
  const instance = await DuckDBInstance.create(path);
  const db = await instance.connect();

  try {
    await db.run(
      'CREATE TABLE impressions(campaign_id VARCHAR NOT NULL, served_at TIMESTAMP_MS NOT NULL, placement VARCHAR NOT NULL, clicked BOOLEAN NOT NULL, cost_micros BIGINT NOT NULL, device_id VARCHAR)',
    );

    for (const [
      campaign,
      servedAt,
      placement,
      clicked,
      cost,
      device,
    ] of impressions)
      await db.run(
        'INSERT INTO impressions VALUES ($1, $2::TIMESTAMP_MS, $3, $4, $5::BIGINT, $6)',
        [campaign, servedAt, placement, clicked, cost, device],
      );
  } finally {
    db.closeSync();
    instance.closeSync();
  }
}

/** Startup owns the temporary SQLite and DuckDB files; importing the model opens nothing. */
async function setup({ onDispose }: AppSetupContext) {
  const directory = await mkdtemp(join(tmpdir(), 'relate-ad-network-'));

  onDispose(() => rm(directory, { recursive: true, force: true }));
  const campaignsPath = join(directory, 'adserver.sqlite');
  const impressionsPath = join(directory, 'impressions.duckdb');

  writeCampaigns(campaignsPath);
  await writeImpressions(impressionsPath);
  const adServer = sqlite({ connectionId: 'adserver', path: campaignsPath });

  onDispose(() => adServer.close());
  const warehouse = duckdb({
    connectionId: 'warehouse',
    path: impressionsPath,
  });

  onDispose(() => warehouse.close());

  return {
    bindings: [
      bind(salesforceAccounts, simulatedSalesforce().resource('Account'), {
        providerAccountId: salesforceOrgId,
      }),
      bind(adServerCampaigns, adServer.table('campaigns')),
      bind(Impressions, warehouse.table('impressions'), {
        columns: {
          campaignId: 'campaign_id',
          servedAt: 'served_at',
          costMicros: 'cost_micros',
          deviceId: 'device_id',
        },
      }),
    ],
  };
}

export const app = defineApp({ graph, setup });
