/** The org ID the Salesforce stand-in reports; the binding requires it. */
export const salesforceOrgId = '00DAd00000AdNetMAF';

/** Salesforce Accounts: [Id, Name, Industry, Team__c]. */
export const advertisers = [
  ['001Ad00000BrTwaIAF', 'Brightwater Travel', 'Travel', 'emea'],
  ['001Ad00000KsTrnIAF', 'Kestrel Running', 'Retail', 'emea'],
  ['001Ad00000HbRnkIAF', 'Harbor Bank', 'Banking', 'apac'],
] as const;

/** SQLite campaigns: [id, advertiser_id, name, status, budget_minor, flight_start, flight_end]. */
export const campaigns = [
  [
    'cmp_city_breaks',
    '001Ad00000BrTwaIAF',
    'City Breaks',
    'live',
    1_500_000,
    '2026-10-01T00:00:00.000Z',
    '2026-10-31T23:59:59.999Z',
  ],
  [
    'cmp_autumn_escapes',
    '001Ad00000BrTwaIAF',
    'Autumn Escapes',
    'live',
    800_000,
    '2026-10-01T00:00:00.000Z',
    '2026-11-15T23:59:59.999Z',
  ],
  [
    'cmp_trail_launch',
    '001Ad00000KsTrnIAF',
    'Trail Launch',
    'live',
    1_200_000,
    '2026-10-08T00:00:00.000Z',
    '2026-10-31T23:59:59.999Z',
  ],
  [
    'cmp_retargeting',
    '001Ad00000KsTrnIAF',
    'Retargeting Test',
    'scheduled',
    200_000,
    '2026-11-01T00:00:00.000Z',
    '2026-11-30T23:59:59.999Z',
  ],
  [
    'cmp_savings',
    '001Ad00000HbRnkIAF',
    'Savings Push',
    'live',
    2_000_000,
    '2026-10-01T00:00:00.000Z',
    '2026-10-31T23:59:59.999Z',
  ],
] as const;

/** Delivery per campaign; Retargeting Test has not served yet. */
const delivery = [
  {
    campaign: 'cmp_city_breaks',
    impressions: 40,
    clicks: 6,
    costMicros: 2_500,
  },
  {
    campaign: 'cmp_autumn_escapes',
    impressions: 25,
    clicks: 1,
    costMicros: 1_800,
  },
  {
    campaign: 'cmp_trail_launch',
    impressions: 50,
    clicks: 4,
    costMicros: 3_000,
  },
  { campaign: 'cmp_savings', impressions: 30, clicks: 3, costMicros: 4_000 },
] as const;

const placements = ['homepage', 'article', 'video'] as const;
const hour = 3_600_000;

/**
 * DuckDB impressions: [campaign_id, served_at, placement, clicked, cost_micros, device_id].
 * One row per served ad, every 8 hours from the flight start, with clicks spread evenly.
 */
export const impressions = delivery.flatMap(
  ({ campaign, impressions: count, clicks, costMicros }) => {
    const start = Date.parse(campaigns.find(([id]) => id === campaign)![5]);

    return Array.from({ length: count }, (_, index) => {
      const clicked =
        Math.floor(((index + 1) * clicks) / count) >
        Math.floor((index * clicks) / count);

      return [
        campaign,
        new Date(start + index * 8 * hour).toISOString(),
        placements[index % placements.length]!,
        clicked,
        costMicros,
        index % 4 === 3 ? null : `device-${index % 5}`,
      ] as const;
    });
  },
);
