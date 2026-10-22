import type { Relate } from '@relate/node';
import { Advertiser, Campaign, graph } from './graph.js';
import { advertisers, campaigns } from './data.js';

/** Adopt the known advertisers and campaigns. Impression rows stay in DuckDB. */
export async function seed(relate: Relate<typeof graph>) {
  for (const [id] of advertisers) await relate.host.adopt(Advertiser, id);

  for (const [id] of campaigns) await relate.host.adopt(Campaign, id);
}
