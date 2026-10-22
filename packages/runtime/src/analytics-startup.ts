import { CompileError } from 'relate/diagnostics';
import type { Manifest, ModelIssue } from 'relate/model';
import type {
  SqlParser,
  ComputedResultType,
  AnalyticalLimits,
} from 'relate/analytics';
import { analyticalDeclarations } from './authorization/index.js';
import {
  prepareExpression,
  AnalyticalPreparationError,
} from './analytics/index.js';

/** Validate every declaration before serving, independent of any actor or selected field. */
export function validateDeclaredCalculations(
  manifest: Manifest,
  parser: SqlParser,
  limits: AnalyticalLimits = {},
): Readonly<Record<string, ComputedResultType>> {
  const types: Record<string, ComputedResultType> = {};
  const issues: ModelIssue[] = [];

  for (const object of manifest.objects) {
    const scope = analyticalDeclarations(manifest, object);

    for (const calculation of object.calculations ?? []) {
      try {
        const prepared = prepareExpression({
          ...limits,
          parser,
          scope,
          expression: { sql: calculation.sql },
          declared: true,
        });

        Object.defineProperty(types, calculation.id, {
          value: Object.freeze({ ...prepared.aggregate.result }),
          enumerable: true,
        });
      } catch (error) {
        if (!(error instanceof AnalyticalPreparationError)) throw error;

        for (const issue of error.issues)
          issues.push({
            code: 'calculation.invalid-definition',
            definitionId: calculation.id,
            message: issue.message,
            path: {
              root: 'graph',
              segments: [
                'objects',
                object.apiName,
                'properties',
                calculation.name,
                'sql',
              ],
            },
          });
      }
    }
  }

  if (issues.length) throw new CompileError(issues);

  return Object.freeze(types);
}
