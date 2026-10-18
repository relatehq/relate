import { describe, expect, it } from 'vitest';
import { parseExpression, namedParameters } from '../parser.js';
import { resolveExpression } from '../resolve.js';
import { inputValue, resultValue } from '../values.js';
import { association, expressions } from './support.js';
import { accepted, rejected } from './corpus.js';

describe('parser and portable resolution', () => {
  it.each(accepted)(
    'lowers $name to parser-independent nodes',
    async ({ sql }) => {
      const query = await parseExpression(sql);

      expect(query.association).toBe('events');
      expect(JSON.stringify(query)).not.toContain('ColumnRef');
      expect(resolveExpression(query, { sql }, association())).toMatchObject({
        type: sql.includes('AVG(') ? 'float64' : 'int64',
      });
    },
  );
  it.each(rejected)('fails closed: %s', async (sql) => {
    await expect(parseExpression(sql)).rejects.toMatchObject({
      code: 'invalid-request',
    });
  });
  it('has a stable canonical representation', async () => {
    expect(
      await parseExpression(
        'SELECT COUNT(*) FROM self.events e WHERE e.eventType = $kind',
      ),
    ).toEqual({
      association: 'events',
      aggregate: 'count',
      argument: '*',
      distinct: false,
      predicate: {
        kind: 'compare',
        op: '=',
        left: { kind: 'column', name: 'eventtype' },
        right: { kind: 'parameter', name: 'kind' },
      },
    });
  });
  it('rewrites only parameter tokens, preserving quotes, dollar strings and nested comments', () => {
    const sql = `SELECT '$since', 'it''s $since', "$since", $$ $since $$, $tag$ $since $tag$ /* $since /* $x */ */ -- $x\n $since, $since, $until`;

    expect(namedParameters(sql)).toEqual({
      sql: sql.replace(' $since, $since, $until', ' $1, $1, $2'),
      names: ['since', 'until'],
    });
    expect(() => namedParameters('SELECT $1')).toThrow('positional-parameter');
  });
  it('infers and canonicalizes timestamp parameters', async () => {
    const expression = expressions().loginsOct!;

    expect(
      resolveExpression(
        await parseExpression(expression.sql),
        expression,
        association(),
      ),
    ).toMatchObject({
      parameterTypes: { since: 'timestamp', until: 'timestamp' },
      values: { since: '2026-10-01T00:00:00.000Z' },
    });
  });
  it('rejects conflicting parameter types and hidden association names', async () => {
    const sql =
      'SELECT COUNT(*) FROM self.events e WHERE e.amount = $x AND e.eventType = $x';
    const query = await parseExpression(sql);

    expect(() =>
      resolveExpression(query, { sql, parameters: { x: '2' } }, association()),
    ).toThrow('parameter-type-conflict');
  });
  it('includes WHERE-only restricted columns and self dependencies in authorization', async () => {
    const sql =
      'SELECT COUNT(*) FROM self.events e WHERE e.userId IS NULL AND e.occurredAt >= self.customerSince';

    expect(
      resolveExpression(await parseExpression(sql), { sql }, association()),
    ).toMatchObject({
      forbidden: true,
      dependencies: ['externalId', 'customerSince'],
    });
  });
  it('rejects schema names colliding after PG folding', async () => {
    const model = association();

    model.columns.userid = model.columns.userId!;
    const sql = 'SELECT COUNT(*) FROM self.events';

    expect(() =>
      resolveExpression(
        {
          association: 'events',
          aggregate: 'count',
          argument: '*',
          distinct: false,
        },
        { sql },
        model,
      ),
    ).toThrow('identifier-collision');
  });
  it.each([
    '2026-10-01',
    '2026-02-30T00:00:00Z',
    '2026-10-01T24:00:00Z',
    '2026-10-01T00:00:00.000001Z',
  ])('rejects unsupported or invalid instant %s', (value) => {
    expect(() => inputValue(value, 'timestamp')).toThrow('invalid-value');
  });
  it('rejects rounded, overflowing and nonfinite results', () => {
    for (const value of [9007199254740992, '9223372036854775808', null])
      expect(() =>
        resultValue(value, { type: 'int64', nullable: false }),
      ).toThrow('invalid-result');

    expect(() => resultValue(NaN, { type: 'float64', nullable: true })).toThrow(
      'invalid-result',
    );
    expect(() =>
      resultValue('2026-10-01T00:00:00Z', {
        type: 'timestamp',
        nullable: true,
      }),
    ).toThrow('invalid-result');
  });
  it('enforces SQL and AST size limits before execution', async () => {
    await expect(parseExpression(' '.repeat(4097))).rejects.toThrow(
      'sql-limit',
    );
    await expect(
      parseExpression(
        `SELECT COUNT(*) FROM self.events WHERE ${Array(70).fill('amount = 1').join(' OR ')}`,
      ),
    ).rejects.toThrow('node-limit');
  });
});
