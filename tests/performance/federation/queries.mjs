export const since = '2026-10-01T00:00:00.000Z';
export const until = '2026-11-01T00:00:00.000Z';
export const eventFilter = `type = 'login' AND "at" >= '${since}' AND "at" < '${until}'`;

export function querySql(scenario, cached = false) {
  if (scenario === 'control') return 'SELECT 1 AS value';

  const prefix = cached ? 'cached_' : '';
  const multi = ['multi', 'multi-bulk', 'selective'].includes(scenario);
  const file = multi || scenario === 'ranking-file';
  const selective = scenario === 'selective';
  const keyFilter = selective ? " AND customer = '00000001'" : '';

  return `WITH e AS (
    SELECT customer, COUNT(*) AS n, MAX("at") AS last_login
    FROM ${prefix}${file ? 'file_events' : 'events'}
    WHERE ${eventFilter}${keyFilter} GROUP BY customer
  )${
    multi
      ? `, i AS (
    SELECT customer, SUM(amount) AS paid FROM ${prefix}invoices
    WHERE paid = true${keyFilter} GROUP BY customer
  )`
      : ''
  }
  SELECT c.key, c.name, CAST(COALESCE(e.n, 0) AS VARCHAR) AS login_count,
    e.last_login${multi ? ', CAST(COALESCE(i.paid, 0) AS VARCHAR) AS paid' : ''}
  FROM ${prefix}customers c LEFT JOIN e ON c.key = e.customer
  ${multi ? 'LEFT JOIN i ON c.key = i.customer' : ''}
  WHERE c.portfolio = 'north'${selective ? " AND c.key = '00000001'" : ''}
  ORDER BY COALESCE(e.n, 0) DESC, c.key ASC${['bulk', 'multi-bulk'].includes(scenario) ? '' : ' LIMIT 25'}`;
}

// The fixture and DataFusion session use UTC. Arrow JSON timestamps without a
// zone must not be interpreted in the Node process's local timezone (DST).
export function utcTimestamp(value) {
  if (value instanceof Date) return value.toISOString();

  const text = String(value);

  return new Date(
    /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : `${text}Z`,
  ).toISOString();
}

export function normalize(rows) {
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    login_count: String(row.login_count),
    last_login: row.last_login == null ? null : utcTimestamp(row.last_login),
    ...(row.paid === undefined ? {} : { paid: String(row.paid) }),
  }));
}
