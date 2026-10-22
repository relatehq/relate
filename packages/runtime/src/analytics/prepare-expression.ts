import type { AnalyticalExpression, SqlParser } from 'relate/analytics';
import { resolveExpression } from './resolve.js';
import { AnalyticalPreparationError } from './expression-types.js';
import type {
  ActorAssociations,
  ResolvedExpression,
} from './expression-types.js';

/** One expression's common parser/resolver boundary, used by startup and requests. */
export function prepareExpression(input: {
  readonly parser: SqlParser;
  readonly scope: ActorAssociations;
  readonly expression: AnalyticalExpression;
  readonly declared?: boolean;
  readonly maxSqlBytes?: number;
  readonly maxParameters?: number;
  readonly maxParameterBytes?: number;
}): ResolvedExpression {
  const { expression } = input;

  for (const limit of [
    input.maxSqlBytes ?? 4096,
    input.maxParameters ?? 16,
    input.maxParameterBytes ?? 1024,
  ])
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid analytical preparation limits');

  const fail = (message: string): never => {
    throw new AnalyticalPreparationError([
      { problem: 'invalid-value', message },
    ]);
  };

  if (
    !expression ||
    typeof expression !== 'object' ||
    Array.isArray(expression) ||
    Object.keys(expression).some(
      (key) => !['sql', 'parameters'].includes(key),
    ) ||
    typeof expression.sql !== 'string'
  )
    fail(
      'An analytical expression requires SQL and optional named parameters.',
    );

  if (
    new TextEncoder().encode(expression.sql).length >
    (input.maxSqlBytes ?? 4096)
  )
    fail('The expression exceeds the SQL size limit.');

  const parsed = input.parser.parse(expression.sql);

  if (!parsed.ok) throw new AnalyticalPreparationError(parsed.issues);

  return resolveExpression(parsed.query, input.scope, expression.parameters, {
    ...(input.declared === undefined ? {} : { declared: input.declared }),
    ...(input.maxParameters === undefined
      ? {}
      : { maxParameters: input.maxParameters }),
    ...(input.maxParameterBytes === undefined
      ? {}
      : { maxParameterBytes: input.maxParameterBytes }),
  });
}
