import { loadModule, parseSync, hasSqlDetails } from 'libpg-query';
import type { SqlParser, ParseResult } from 'relate/analytics';
import { RejectedSql, reject } from './errors.js';
import { characterOffset, rewriteParameters } from './source.js';
import type { SqlSource } from './source.js';
import { lower } from './lower.js';

export interface SqlParserLimits {
  readonly maxSqlBytes?: number;
  readonly maxNodes?: number;
  readonly maxParameters?: number;
}

let initialization: Promise<void> | undefined;
const grammarVersion = 180004;

/** Load the pinned grammar once; returned parsers never perform asynchronous I/O. */
export async function createSqlParser(
  limits: SqlParserLimits = {},
): Promise<SqlParser> {
  const maxSqlBytes = limits.maxSqlBytes ?? 4096;
  const maxNodes = limits.maxNodes ?? 256;
  const maxParameters = limits.maxParameters ?? 16;

  for (const value of [maxSqlBytes, maxNodes, maxParameters])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('SQL parser limits must be positive integers');

  await (initialization ??= loadModule().catch((error: unknown) => {
    initialization = undefined;
    throw error;
  }));

  if (parseSync('SELECT 1').version !== grammarVersion)
    throw new Error('Unsupported SQL grammar version');

  return Object.freeze({
    grammarVersion,
    parse(sql: string): ParseResult {
      let source: SqlSource | undefined;

      try {
        if (typeof sql !== 'string')
          reject('invalid-value', 'SQL must be a string.');

        if (new TextEncoder().encode(sql).length > maxSqlBytes)
          reject('invalid-value', 'The expression exceeds the SQL size limit.');

        for (const character of sql) {
          const point = character.codePointAt(0)!;

          if (point === 0 || (point >= 0xd800 && point <= 0xdfff))
            reject('invalid-value', 'SQL contains an invalid character.');
        }

        source = rewriteParameters(sql, maxParameters);

        if (source.grammarVersion !== grammarVersion)
          reject('not-supported', 'Unsupported SQL grammar version.');

        return {
          ok: true,
          query: lower(parseSync(source.sql), source, maxNodes),
        };
      } catch (error) {
        if (error instanceof RejectedSql)
          return { ok: false, issues: [error.issue] };

        // Driver parser text can echo SQL literals. Only its position is public.
        const position = hasSqlDetails(error)
          ? error.sqlDetails?.cursorPosition
          : undefined;
        const offset =
          typeof position === 'number' &&
          Number.isSafeInteger(position) &&
          position >= 0
            ? characterOffset(source?.sql ?? sql, position)
            : undefined;
        const start =
          offset === undefined
            ? undefined
            : source
              ? (source.original[offset] ?? sql.length)
              : offset;

        return {
          ok: false,
          issues: [
            {
              problem: 'invalid-value',
              message: 'Invalid SQL expression.',
              ...(start === undefined
                ? {}
                : { at: { start, end: Math.min(start + 1, sql.length) } }),
            },
          ],
        };
      }
    },
  });
}
