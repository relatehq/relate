export const octoberLogins = {
  sql: `SELECT COUNT(*) FROM self.events e
    WHERE e.eventType = 'login' AND e.occurredAt >= $since AND e.occurredAt < $until`,
  parameters: {
    since: '2026-10-01T00:00:00.000Z',
    until: '2026-11-01T00:00:00.000Z',
  },
} as const;

export const lastLogin = {
  sql: "SELECT MAX(e.occurredAt) FROM self.events e WHERE e.eventType = 'login'",
} as const;

export const loginsSinceCustomer = {
  sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login' AND e.occurredAt >= self.customerSince",
} as const;
