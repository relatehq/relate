import { since, until } from './model.js';

const compute = {
  loginCount: {
    sql: "SELECT COUNT(*) FROM self.events AS e WHERE e.eventType = 'login' AND e.occurredAt >= $since AND e.occurredAt < $until",
    parameters: { since, until },
  },
  lastLogin: {
    sql: "SELECT MAX(e.occurredAt) FROM self.events AS e WHERE e.eventType = 'login' AND e.occurredAt >= $since AND e.occurredAt < $until",
    parameters: { since, until },
  },
};

// Fixed requests executed through the public typed consumer API.
export const scenarios = {
  objects: { select: ['name'], where: { portfolio: 'north' }, limit: 25 },
  enrichment: {
    select: ['name'],
    where: { portfolio: 'north' },
    compute,
    limit: 25,
  },
  ranking: {
    select: ['name'],
    where: { portfolio: 'north' },
    compute,
    orderBy: [{ field: 'loginCount', direction: 'desc' }],
    limit: 25,
  },
} as const;

export type Scenario = keyof typeof scenarios;
export type Request = (typeof scenarios)[Scenario];
