import { scanSync } from 'libpg-query';
import type { Name, SourceSpan } from 'relate/analytics';
import { reject, unsupported } from './errors.js';

interface Token extends SourceSpan {
  readonly text: string;
}

/** libpg_query locations count UTF-8 bytes; public spans count UTF-16 units. */
function byteOffsets(sql: string): number[] {
  const offsets: number[] = [];
  let index = 0;

  for (const character of sql) {
    const bytes = new TextEncoder().encode(character).length;

    for (let i = 0; i < bytes; i++) offsets.push(index);

    index += character.length;
  }

  offsets.push(index);

  return offsets;
}

export function characterOffset(sql: string, position: number): number {
  let count = 0,
    index = 0;

  for (const character of sql) {
    if (count++ >= position) break;

    index += character.length;
  }

  return index;
}

/** PostgreSQL's scanner skips the contents of strings, identifiers and comments. */
export function rewriteParameters(sql: string, maxParameters: number) {
  const bytes = byteOffsets(sql);
  const scanned = scanSync(sql);
  const tokens: Token[] = scanned.tokens
    .filter((token) => !['SQL_COMMENT', 'C_COMMENT'].includes(token.tokenName))
    .map((token) => ({
      start: bytes[token.start]!,
      end: bytes[token.end]!,
      text: token.text,
    }));
  const parameters: { name: string; at: SourceSpan; replacement: string }[] =
    [];
  const names: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (/^\$[0-9]+$/.test(token.text))
      reject(
        'invalid-value',
        'Use named parameters, not positional parameters.',
        token,
      );

    if (token.text !== '$') continue;

    const next = tokens[index + 1];

    if (
      !next ||
      token.end !== next.start ||
      !/^[A-Za-z_][A-Za-z_0-9]*$/.test(next.text)
    )
      reject(
        'invalid-value',
        'A named parameter must use $name syntax.',
        token,
      );

    if (!names.includes(next.text)) names.push(next.text);

    if (names.length > maxParameters)
      reject(
        'invalid-value',
        'The expression exceeds the parameter limit.',
        token,
      );

    parameters.push({
      name: next.text,
      at: { start: token.start, end: next.end },
      replacement: `$${names.indexOf(next.text) + 1}`,
    });
    index++;
  }

  let rewritten = '',
    previous = 0;
  const original: number[] = [];
  const append = (start: number, end: number) => {
    for (let offset = start; offset < end; offset++) {
      original.push(offset);
      rewritten += sql[offset];
    }
  };

  for (const parameter of parameters) {
    append(previous, parameter.at.start);

    for (const character of parameter.replacement) {
      original.push(parameter.at.start);
      rewritten += character;
    }

    previous = parameter.at.end;
  }

  append(previous, sql.length);
  original.push(sql.length);
  const rewrittenBytes = byteOffsets(rewritten);
  const originalOffset = (location: number) =>
    original[rewrittenBytes[location] ?? rewritten.length] ?? sql.length;
  const tokenIndex = (location: number) =>
    tokens.findIndex((token) => token.start === originalOffset(location));

  return {
    sql: rewritten,
    names,
    original,
    grammarVersion: scanned.version,
    span(location: number): SourceSpan {
      const token = tokens[tokenIndex(location)];

      if (!token)
        return {
          start: originalOffset(location),
          end: originalOffset(location),
        };

      const parameter = parameters.find(
        (entry) => entry.at.start === token.start,
      );

      if (parameter) return parameter.at;

      const next = tokens[tokenIndex(location) + 1];

      return {
        start: token.start,
        end: token.text === '-' && next ? next.end : token.end,
      };
    },
    identifiers(location: number, values: readonly string[]): Name[] {
      let index = tokenIndex(location);

      return values.map((name, position) => {
        const token = tokens[index];

        if (!token) return unsupported();

        let end = token.end;

        index++;

        // Unicode identifier escapes can choose a custom escape character.
        if (
          /^u&"/i.test(token.text) &&
          tokens[index]?.text.toLowerCase() === 'uescape'
        ) {
          end = tokens[index + 1]?.end ?? end;
          index += 2;
        }

        if (position < values.length - 1) {
          if (tokens[index]?.text !== '.') return unsupported(token);

          index++;
        }

        return {
          name,
          quoted: /^("|u&")/i.test(token.text),
          at: { start: token.start, end },
        };
      });
    },
  };
}

export type SqlSource = ReturnType<typeof rewriteParameters>;
