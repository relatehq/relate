import { expect, it } from 'vitest';
import { createSqlParser } from '@relate/sql-parser';
import type { RelateSqlQuery } from 'relate/analytics';
import {
  sqlCorpus,
  semanticQuery,
} from '../../../tests/support/sql-corpus/index.js';

async function parse(
  sql: string,
): Promise<
  Extract<
    RelateSqlQuery,
    { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max' }
  >
> {
  const parser = await createSqlParser();
  const result = parser.parse(sql);

  if (!result.ok) throw new Error(JSON.stringify(result.issues));

  if (result.query.aggregate === 'expression')
    throw new Error('Expected a single aggregate');

  return result.query;
}

it.each(sqlCorpus)(
  'matches the shared syntax contract: $name',
  async ({ sql, expect: expected }) => {
    const parser = await createSqlParser();
    const result = parser.parse(sql);

    if (expected.phase === 'parse') {
      expect(result).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ problem: expected.problem })],
      });
    } else {
      expect(result.ok).toBe(true);

      if (result.ok)
        expect(semanticQuery(result.query)).toEqual(expected.representation);
    }
  },
);

it('initializes once and returns a synchronous parser with the pinned grammar', async () => {
  const parsers = await Promise.all([createSqlParser(), createSqlParser()]);

  for (const parser of parsers) {
    expect(parser.grammarVersion).toBe(180004);
    expect(parser.parse('SELECT COUNT(*) FROM self.events')).not.toBeInstanceOf(
      Promise,
    );
  }
});

it('preserves quoted case, exact numeric text and original UTF-16 spans', async () => {
  const sql =
    'SELECT MAX(e."eventType") FROM self."Events" e WHERE e."é😀" = $longParameter AND e.value = 9223372036854775807';
  const query = await parse(sql);

  expect(query.association).toEqual({
    name: 'Events',
    quoted: true,
    at: { start: sql.indexOf('"Events"'), end: sql.indexOf('"Events"') + 8 },
  });
  expect(query.argument).toEqual({
    kind: 'column',
    name: 'eventType',
    quoted: true,
    at: {
      start: sql.indexOf('"eventType"'),
      end: sql.indexOf('"eventType"') + 11,
    },
  });
  expect(query.predicate).toMatchObject({
    kind: 'boolean',
    args: [
      {
        kind: 'compare',
        left: {
          kind: 'column',
          name: 'é😀',
          quoted: true,
          at: { start: sql.indexOf('"é😀"'), end: sql.indexOf('"é😀"') + 5 },
        },
        right: {
          kind: 'parameter',
          name: 'longParameter',
          at: {
            start: sql.indexOf('$longParameter'),
            end: sql.indexOf('$longParameter') + 14,
          },
        },
      },
      {
        kind: 'compare',
        right: {
          kind: 'literal',
          literal: 'number',
          value: '9223372036854775807',
          at: { start: sql.indexOf('9223372036854775807'), end: sql.length },
        },
      },
    ],
  });
});

it('folds unquoted identifiers but preserves exact Unicode-escaped names', async () => {
  const query = await parse(
    String.raw`SELECT MAX(e.U&"event\0054ype") FROM self.EVENTS e WHERE e.EVENTTYPE = ''`,
  );

  expect(query.association).toMatchObject({ name: 'events', quoted: false });
  expect(query.argument).toMatchObject({ name: 'eventType', quoted: true });
  expect(query.predicate).toMatchObject({
    left: { name: 'eventtype', quoted: false },
    right: { literal: 'string', value: '' },
  });
});

it('retains repeated and keyword parameter names without rewriting strings or comments', async () => {
  const query = await parse(
    String.raw`SELECT COUNT(*) FROM self.events WHERE value = $then AND value = $then AND label = E'it\'s $no' /* $ignored */`,
  );

  expect(query.predicate).toMatchObject({
    args: [
      { right: { kind: 'parameter', name: 'then' } },
      { right: { kind: 'parameter', name: 'then' } },
      { right: { literal: 'string', value: "it's $no" } },
    ],
  });
});

it('maps syntax errors after rewriting and multibyte characters back to the original SQL', async () => {
  const parser = await createSqlParser();
  const sql =
    "SELECT COUNT(*) FROM self.events WHERE label = 'é😀' AND value = $longParameter AND )";
  const result = parser.parse(sql);

  expect(result).toMatchObject({
    ok: false,
    issues: [
      {
        at: { start: sql.indexOf(')', sql.indexOf('WHERE')), end: sql.length },
      },
    ],
  });
});

it.each(['secret literal', 'private-host.example', 'password=value'])(
  'sanitizes parser failures containing %s',
  async (secret) => {
    const parser = await createSqlParser();
    const result = parser.parse(
      `SELECT COUNT(*) FROM self.events WHERE '${secret}`,
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);

it('applies finite SQL, parameter and parsed-node limits', async () => {
  const parser = await createSqlParser();

  expect(parser.parse(' '.repeat(4097))).toMatchObject({
    ok: false,
    issues: [{ problem: 'invalid-value' }],
  });
  expect(
    parser.parse(
      `SELECT COUNT(*) FROM self.events WHERE ${Array.from({ length: 17 }, (_, i) => `value = $p${i}`).join(' AND ')}`,
    ),
  ).toMatchObject({
    ok: false,
    issues: [{ message: expect.stringContaining('parameter limit') }],
  });
  const limited = await createSqlParser({ maxNodes: 4 });

  expect(limited.parse('SELECT COUNT(*) FROM self.events')).toMatchObject({
    ok: false,
    issues: [{ message: expect.stringContaining('parsed-node limit') }],
  });
  await expect(createSqlParser({ maxSqlBytes: Infinity })).rejects.toThrow(
    'positive integers',
  );
  await expect(createSqlParser({ maxParameters: 0 })).rejects.toThrow(
    'positive integers',
  );
});

it.each(['\0', '\ud800', '\udc00'])(
  'rejects non-UTF-8 or C-string characters %#',
  async (character) => {
    const parser = await createSqlParser();

    expect(
      parser.parse(
        `SELECT COUNT(*) FROM self.events;${character}DELETE FROM self.events`,
      ),
    ).toMatchObject({ ok: false });
  },
);

it.each([
  ['SELECT SUM(*) FROM self.events', 'SUM'],
  ['SELECT SUM(value, value) FROM self.events', 'SUM'],
  ['SELECT SUM(DISTINCT value) FROM self.events', 'SUM'],
  ['SELECT COALESCE(SUM(value), 0, 1) FROM self.events', 'COALESCE'],
  ['SELECT COALESCE(SUM(value), 0) % 2 FROM self.events', '%'],
  ['SELECT 1 + $value FROM self.events', '1'],
])(
  'reports where unsupported formula syntax occurs: %s',
  async (sql, token) => {
    const parser = await createSqlParser();

    expect(parser.parse(sql)).toMatchObject({
      ok: false,
      issues: [
        {
          problem: 'not-supported',
          at: { start: sql.indexOf(token) },
        },
      ],
    });
  },
);

it.each(['1', "'yes'", 'NULL'])(
  'rejects the non-boolean bare predicate %s at parse time',
  async (constant) => {
    const parser = await createSqlParser();
    const sql = `SELECT COUNT(*) FROM self.events WHERE ${constant}`;

    expect(parser.parse(sql)).toMatchObject({
      ok: false,
      issues: [
        { problem: 'not-supported', at: { start: sql.indexOf(constant) } },
      ],
    });
  },
);

it('lowers bare boolean columns, parameters and constants to equality with true', async () => {
  const query = await parse(
    'SELECT COUNT(*) FILTER (WHERE enabled) FROM self.events WHERE $active AND FALSE',
  );

  expect(query.predicate).toMatchObject({
    kind: 'boolean',
    op: 'and',
    args: [
      {
        kind: 'boolean',
        op: 'and',
        args: [
          {
            op: '=',
            left: { kind: 'parameter', name: 'active' },
            right: { literal: 'boolean', value: true },
          },
          {
            op: '=',
            left: { literal: 'boolean', value: false },
            right: { literal: 'boolean', value: true },
          },
        ],
      },
      {
        op: '=',
        left: { kind: 'column', name: 'enabled' },
        right: { literal: 'boolean', value: true },
      },
    ],
  });
});
