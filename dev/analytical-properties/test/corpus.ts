/** Shared parser/generator cases. Not the complete v1 conformance corpus. */
export const accepted = [
  {
    name: 'typed-literal-comparison',
    sql: 'SELECT COUNT(*) FROM self.events WHERE 2 < 10',
    values: ['4', '1', '0'],
  },
  {
    name: 'count-star',
    sql: 'SELECT COUNT(*) FROM self.events',
    values: ['4', '1', '0'],
  },
  {
    name: 'count-column',
    sql: 'SELECT COUNT(e.userId) FROM self.events e',
    values: ['3', '1', '0'],
  },
  {
    name: 'count-distinct',
    sql: 'SELECT COUNT(DISTINCT e.userId) FROM self.events e',
    values: ['2', '1', '0'],
  },
  {
    name: 'self-property',
    sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login' AND e.occurredAt >= self.customerSince",
    values: ['2', '1', '0'],
  },
  {
    name: 'scope-or',
    sql: "SELECT COUNT(*) FROM self.events e WHERE e.eventType = 'login' OR 1 = 1",
    values: ['4', '1', '0'],
  },
  {
    name: 'null-negation',
    sql: 'SELECT COUNT(*) FROM self.events e WHERE NOT (e.userId IS NOT NULL)',
    values: ['1', '0', '0'],
  },
  {
    name: 'exact-int64',
    sql: 'SELECT SUM(e.amount) FROM self.events e',
    values: ['9007199254741002', '5', null],
  },
  {
    name: 'average-int64',
    sql: 'SELECT AVG(e.amount) FROM self.events e',
    values: [2251799813685250.5, 5, null],
  },
  {
    name: 'minimum',
    sql: 'SELECT MIN(e.amount) FROM self.events e',
    values: ['2', '5', null],
  },
  {
    name: 'quoted-column',
    sql: 'SELECT COUNT(e."userId") FROM self.events AS e',
    values: ['3', '1', '0'],
  },
];

export const rejected = [
  'DELETE FROM self.events',
  'SELECT COUNT(*) FROM self.events; SELECT 1',
  'SELECT COUNT(*) FROM events',
  'SELECT COUNT(*) FROM self.events JOIN self.events e ON true',
  'WITH x AS (SELECT 1) SELECT COUNT(*) FROM self.events',
  'SELECT COUNT(*) FROM self.events GROUP BY customerId',
  'SELECT COUNT(*) FROM self.events HAVING COUNT(*) > 0',
  'SELECT COUNT(*) FROM self.events ORDER BY 1',
  'SELECT COUNT(*) FROM self.events LIMIT 1',
  'SELECT COUNT(*) OVER () FROM self.events',
  'SELECT COUNT(*) FROM self.events UNION SELECT 1',
  "SELECT COUNT(*) FROM pg_read_file('/etc/passwd')",
  'SELECT pg_sleep(10) FROM self.events',
  'SELECT COUNT(*) FROM self.events WHERE EXISTS (SELECT 1)',
  'SELECT COUNT(*) FROM self.events WHERE eventType COLLATE "C" = \'x\'',
  'SELECT COUNT(*) FILTER (WHERE true) FROM self.events',
  'SELECT COUNT(*) AS renamed FROM self.events',
  'SELECT COUNT(*) FROM self.events AS self',
  'SELECT COUNT(*) INTO temp copy FROM self.events',
  'SELECT COUNT(*) FROM ONLY self.events',
  'SELECT COUNT(*) FROM self.events e(a, b)',
  'SELECT SUM(DISTINCT amount) FROM self.events',
  'SELECT COUNT(*) FROM self.events WHERE amount = CAST($n AS BIGINT)',
  'SELECT COALESCE(SUM(amount), 0) FROM self.events',
];
