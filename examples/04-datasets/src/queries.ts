/** Caller expression: impressions served in a reporting window the caller chooses. */
export const servedInWindow = {
  sql: `SELECT COUNT(*) FROM self.impressions i
    WHERE i.servedAt >= $since AND i.servedAt < $until`,
  parameters: {
    since: '2026-10-01T00:00:00.000Z',
    until: '2026-10-08T00:00:00.000Z',
  },
} as const;

/** Caller expression: video clicks, filtered on an ordinary column. */
export const videoClicks = {
  sql: "SELECT COUNT(*) FROM self.impressions i WHERE i.clicked = TRUE AND i.placement = 'video'",
} as const;

/** Reach needs device IDs, which only the privacy role may read. */
export const reach = {
  sql: 'SELECT COUNT(DISTINCT i.deviceId) FROM self.impressions i',
} as const;

/** Caller form of the declared `ctr`: clicks per impression for a chosen placement. */
export const placementCtr = {
  sql: `SELECT COUNT(*) FILTER (WHERE i.clicked = TRUE) * 1.0 / NULLIF(COUNT(*), 0)
    FROM self.impressions i WHERE i.placement = $placement`,
  parameters: { placement: 'video' },
} as const;

/** The declared `ctr` written as a caller expression. */
export const clickThroughRate = {
  sql: 'SELECT COUNT(*) FILTER (WHERE i.clicked = TRUE) * 1.0 / NULLIF(COUNT(*), 0) FROM self.impressions i',
} as const;
