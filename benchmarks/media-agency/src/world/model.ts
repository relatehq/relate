export type Tier = 'S' | 'M' | 'L';
export type Platform = 'meta' | 'tiktok' | 'ttd' | 'google-ads';
export type Principal = 'priya' | 'marco' | 'fiona';
export type Currency = 'GBP' | 'EUR' | 'USD';
export const platforms: Platform[] = ['meta', 'tiktok', 'ttd', 'google-ads'];

export const tiers = {
  S: { clients: 8, campaigns: 160, groups: 3, ads: 4 },
  M: { clients: 40, campaigns: 800, groups: 4, ads: 5 },
  L: { clients: 150, campaigns: 3000, groups: 5, ads: 4 },
} as const;

export interface Client {
  id: string;
  code: string;
  name: string;
  team: string;
  currency: Currency;
  feePct: number;
}

export interface Account {
  id: string;
  clientId: string;
  platform: Platform;
  currency: Currency;
  timezone: string;
}

export interface Campaign {
  id: string;
  accountId: string;
  platform: Platform;
  name: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  budgetMinor: number;
  budgetId: string;
  flightStart: string;
  flightEnd: string;
  missingLink: boolean;
  malformedName: boolean;
}

export interface PlanLine {
  id: string;
  clientId: string;
  campaignId: string;
  linkedId: string | null;
  platform: Platform;
  channel: string;
  budgetMinor: number;
  currency: Currency;
  flightStart: string;
  flightEnd: string;
}

export interface AdGroup {
  id: string;
  campaignId: string;
  name: string;
  budgetMinor: number;
  status: string;
}

export interface Ad {
  id: string;
  groupId: string;
  campaignId: string;
  status: string;
}

export interface Delivery {
  adId: string;
  campaignId: string;
  platform: Platform;
  date: string;
  currency: Currency;
  spendMicros: number;
  impressions: number;
  clicks: number;
  conversions: number;
}

export interface Invoice {
  id: string;
  campaignId: string;
  clientId: string;
  amountMinor: number;
  currency: Currency;
  month: string;
}

export interface World {
  version: 1;
  seed: number;
  tier: Tier;
  now: string;
  clients: Client[];
  accounts: Account[];
  campaigns: Campaign[];
  lines: PlanLine[];
  groups: AdGroup[];
  ads: Ad[];
  invoices: Invoice[];
}

export interface Mutation {
  seq: number;
  system: string;
  entity: string;
  id: string;
  op: 'create' | 'update';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestId: string;
}

export interface RequestRecord {
  seq: number;
  system: string;
  method: string;
  path: string;
  write: boolean;
  target: string;
  outcome: string;
  requestId: string;
}

export interface Fault {
  system: Platform;
  target: string;
  nth: number;
  kind:
    | 'timeout-after-commit'
    | 'timeout-before-commit'
    | 'rate-limit-429'
    | 'server-500';
}

export const people = {
  priya: { role: 'planner', team: 'retail' },
  marco: { role: 'activation-lead', team: '*' },
  fiona: { role: 'finance', team: '*' },
} as const;

export const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
