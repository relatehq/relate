import { expect, it } from 'vitest';
import { loadModule, parseSync } from 'libpg-query';
import { lower } from '../src/lower.js';
import { rewriteParameters } from '../src/source.js';

it.each([
  "SELECT COALESCE(COUNT(DISTINCT e.value), 0) FROM self.events e WHERE NOT (e.value >= $minimum OR e.label IS NULL) AND e.label = 'a' AND e.enabled = FALSE",
  'SELECT COALESCE(COUNT(*) FILTER (WHERE enabled) * 1.0 / NULLIF(SUM(value) + self.budget, 0), $fallback) FROM self.events',
])('rejects an unrecognized key on every parsed object: %s', async (sql) => {
  await loadModule();
  const source = rewriteParameters(sql, 16);
  const tree = parseSync(source.sql);
  const paths: (string | number)[][] = [];
  const visit = (value: unknown, path: (string | number)[]) => {
    if (!value || typeof value !== 'object') return;

    if (!Array.isArray(value)) paths.push(path);

    for (const [key, child] of Object.entries(value))
      visit(child, [...path, Array.isArray(value) ? Number(key) : key]);
  };

  visit(tree, []);
  expect(paths.length).toBeGreaterThan(20);

  for (const path of paths) {
    const changed = structuredClone(tree);
    let node = changed as unknown as Record<string | number, unknown>;

    for (const key of path)
      node = node[key] as Record<string | number, unknown>;

    node.unrecognized = true;
    expect(() => lower(changed, source, 1000), path.join('.')).toThrow(
      'outside the analytical subset',
    );
  }
});

it.each(['constructor', '__proto__', 'NEW_BOOLEAN_OPERATION'])(
  'rejects unknown boolean enum %s',
  async (name) => {
    await loadModule();
    const source = rewriteParameters(
      'SELECT COUNT(*) FROM self.events WHERE x = 1 AND y = 2',
      16,
    );
    const tree = parseSync(source.sql);
    const select = (
      tree as unknown as {
        stmts: {
          stmt: { SelectStmt: { whereClause: { BoolExpr: object } } };
        }[];
      }
    ).stmts[0]!.stmt.SelectStmt;

    Object.assign(select.whereClause.BoolExpr, { boolop: name });
    expect(() => lower(tree, source, 256)).toThrow(
      'outside the analytical subset',
    );
  },
);
