import type { ResultType, SqlParser } from 'relate/analytics';
import { prepareExpression } from './prepare.js';
import { expressionEntries } from './request.js';
import type { ComputeRequest, PreparationLimits } from './request.js';
import type { ResolvedCalculation } from './execution-types.js';
import type { ActorAssociations, ResolvedExpression } from './types.js';
import { AnalyticalPreparationError } from './types.js';
import { beginTiming } from './timings.js';
import type { TimingCapture } from './timings.js';

declare const prepared: unique symbol;

/** Request-local handle: executable expressions and values are not enumerable. */
export interface PreparedCompute {
  readonly [prepared]: true;
  readonly dependencies: readonly string[];
  readonly results: Readonly<Record<string, ResultType>>;
}

const handles = new WeakMap<PreparedCompute, readonly ResolvedCalculation[]>();

/** Only the analytics executor can recover private resolved state from a handle. */
export function preparedFields(handle: PreparedCompute) {
  const fields = handles.get(handle);

  if (!fields) throw new Error('Unknown or consumed analytical preparation');

  handles.delete(handle);

  return fields;
}

/** Apply actor access to trusted declared SQL without exposing hidden names in errors. */
export function authorizeDeclaration(
  expression: ResolvedExpression,
  scope: ActorAssociations,
): ResolvedExpression {
  const association = scope.associations.find(
    (entry) => entry.id === expression.association.id,
  );
  const readable = (id: string) =>
    scope.properties.find((entry) => entry.id === id)?.readable === true;

  return {
    ...expression,
    ...(association ? { association } : {}),
    forbidden:
      !association ||
      expression.columns.some(
        (id) => !association.columns.find((entry) => entry.id === id)?.readable,
      ) ||
      expression.dependencies.some(
        (dependency) => !dependency.correlation && !readable(dependency.id),
      ),
    correlationForbidden: expression.dependencies.some(
      (dependency) => dependency.correlation && !readable(dependency.id),
    ),
  };
}

/** No I/O: validate both forms, discover ordinary dependencies, infer projected metadata. */
export function prepareCompute(input: {
  readonly parser: SqlParser;
  readonly associations: ActorAssociations;
  /** Full model view for trusted declarations only; caller SQL never uses it. */
  readonly declarations: ActorAssociations;
  readonly request: ComputeRequest;
  readonly limits?: PreparationLimits;
  readonly timings?: TimingCapture;
}): PreparedCompute {
  const end = beginTiming(input.timings, 'preparation');

  try {
    const limits = input.limits ?? {};
    const entries = expressionEntries(
      input.request,
      input.declarations.properties.map((property) => property.name),
      limits,
    );
    const fields: ResolvedCalculation[] = [];

    for (const [name, expression] of entries) {
      try {
        fields.push({
          name,
          project: true,
          required: input.request.requiredAliases?.includes(name) ?? false,
          readable: true,
          expression: prepareExpression({
            parser: input.parser,
            scope: input.associations,
            expression,
            ...limits,
          }),
        });
      } catch (error) {
        if (!(error instanceof AnalyticalPreparationError)) throw error;

        throw new AnalyticalPreparationError(
          error.issues.map((issue) => ({
            ...issue,
            path: ['compute', name, 'sql'],
          })),
        );
      }
    }

    for (const declaration of input.request.declarations) {
      const property = input.declarations.properties.find(
        (property) => property.id === declaration.definitionId,
      );

      if (!property?.calculated || property.name !== declaration.name)
        throw new Error('Invalid normalized calculation identity');

      try {
        fields.push({
          name: declaration.name,
          definitionId: declaration.definitionId,
          project: declaration.project,
          required: declaration.required,
          readable:
            declaration.readable &&
            input.associations.properties.find(
              (property) => property.id === declaration.definitionId,
            )?.readable === true,
          expression: authorizeDeclaration(
            prepareExpression({
              parser: input.parser,
              scope: input.declarations,
              expression: { sql: declaration.sql },
              declared: true,
              ...limits,
            }),
            input.associations,
          ),
        });
      } catch (error) {
        if (!(error instanceof AnalyticalPreparationError)) throw error;

        // Startup reports authored SQL errors. Request errors must not disclose it.
        throw new AnalyticalPreparationError([
          {
            problem: 'invalid-value',
            path: ['select', declaration.name],
            message:
              'The declared calculation does not meet analytical request limits.',
          },
        ]);
      }
    }

    // Detach the request, model, and parser output before any asynchronous read.
    const snapshot = structuredClone(fields);
    const handle = Object.freeze({
      dependencies: Object.freeze([
        ...new Set(
          snapshot
            .filter(
              (field) =>
                field.readable &&
                !field.expression.forbidden &&
                !field.expression.correlationForbidden,
            )
            .flatMap((field) =>
              field.expression.dependencies.map((dependency) => dependency.id),
            ),
        ),
      ]),
      results: Object.freeze(
        Object.fromEntries(
          snapshot
            .filter((field) => field.project)
            .map((field) => [
              field.name,
              Object.freeze({ ...field.expression.aggregate.result }),
            ]),
        ),
      ),
    }) as PreparedCompute;

    handles.set(handle, snapshot);

    return handle;
  } finally {
    end();
  }
}

/** Cursor scope includes every referenced dataset, including withheld declarations. */
export function preparedBindingRevisions(
  handle: PreparedCompute,
  revision: (datasetId: string) => string,
): Readonly<Record<string, string>> {
  const fields = handles.get(handle);

  if (!fields) throw new Error('Unknown or consumed analytical preparation');

  return Object.freeze(
    Object.fromEntries(
      [
        ...new Set(
          fields.map(
            (field) => field.expression.association.datasetDefinitionId,
          ),
        ),
      ]
        .sort()
        .map((id) => [id, revision(id)]),
    ),
  );
}
