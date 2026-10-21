import {
  analyticalFailureReasons,
  analyticalSummaryLimits,
} from '@relate/protocol';
import type {
  AnalyticalCalculationSummary,
  AnalyticalFailureReason,
  AnalyticalSummary,
} from '@relate/protocol';
import type { ResolvedCalculation } from './execution-types.js';

/** Only status/reason crosses this diagnostic boundary, never values or evidence. */
type ResultStatus = { readonly status: string; readonly reason?: string };

export interface CalculationCapture {
  prepared(fields: readonly ResolvedCalculation[]): void;
  results(
    fields: Readonly<Record<string, ResultStatus>>,
    previous?: Readonly<Record<string, ResultStatus>>,
    interrupted?: boolean,
  ): void;
}

/** Bounded metadata per prepared expression; no object IDs or growing result list. */
export function createCalculationSummary(flags: {
  computedFilter: boolean;
  computedOrder: boolean;
}) {
  const { computedFilter, computedOrder } = flags;
  const entries = new Map<
    string,
    {
      identity: Omit<AnalyticalCalculationSummary, 'failures'>;
      failures: Partial<Record<AnalyticalFailureReason, number>>;
    }
  >();
  let expressionCount: number | undefined;
  const validId = (id: string) =>
    id.trim().length > 0 &&
    new TextEncoder().encode(id).byteLength <=
      analyticalSummaryLimits.maxIdentifierBytes;
  const reason = (
    field: ResultStatus | undefined,
    interrupted = false,
  ): AnalyticalFailureReason | undefined => {
    const value =
      field?.status === 'pending' && interrupted
        ? 'interrupted'
        : field?.status === 'forbidden'
          ? 'forbidden'
          : field?.status === 'unavailable'
            ? field.reason
            : undefined;

    return analyticalFailureReasons.includes(value as AnalyticalFailureReason)
      ? (value as AnalyticalFailureReason)
      : undefined;
  };

  return {
    prepared(fields: readonly ResolvedCalculation[]) {
      if (expressionCount !== undefined) return;

      expressionCount = fields.length;

      for (const field of fields) {
        const identity = {
          associationId: field.expression.association.id,
          datasetId: field.expression.association.datasetDefinitionId,
          ...(field.definitionId ? { propertyId: field.definitionId } : {}),
        };

        if (
          entries.size >= analyticalSummaryLimits.maxCalculations ||
          !Object.values(identity).every(validId)
        )
          continue;

        entries.set(field.name, { identity, failures: {} });
      }
    },
    results(
      fields: Readonly<Record<string, ResultStatus>>,
      previous?: Readonly<Record<string, ResultStatus>>,
      interrupted = false,
    ) {
      for (const [name, entry] of entries) {
        const before = reason(previous?.[name]);
        const after = reason(fields[name], interrupted);

        if (before === after) continue;

        if (before) {
          const remaining = Math.max(0, (entry.failures[before] ?? 0) - 1);

          if (remaining) entry.failures[before] = remaining;
          else delete entry.failures[before];
        }

        if (after)
          entry.failures[after] = Math.min(
            Number.MAX_SAFE_INTEGER,
            (entry.failures[after] ?? 0) + 1,
          );
      }
    },
    snapshot(): AnalyticalSummary | undefined {
      if (expressionCount === undefined) return undefined;

      return {
        expressionCount,
        computedFilter,
        computedOrder,
        calculations: [...entries.values()].map(({ identity, failures }) => ({
          ...identity,
          failures: { ...failures },
        })),
        ...(expressionCount > entries.size
          ? { omittedCalculations: expressionCount - entries.size }
          : {}),
      };
    },
  };
}

/** Diagnostic failures never change preparation, execution, or revalidation. */
export function captureCalculations(
  capture: CalculationCapture | undefined,
  use: (capture: CalculationCapture) => void,
) {
  if (!capture) return;

  try {
    void Promise.resolve(use(capture)).catch(() => {});
  } catch {
    /* Best effort diagnostics. */
  }
}
