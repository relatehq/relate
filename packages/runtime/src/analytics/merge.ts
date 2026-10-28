import { encodeAnalyticalValue } from 'relate/analytics';
import type { DatasetExecution } from 'relate/connectors';
import type { CandidateRow, CalculationBatch } from './batch.js';
import type {
  ComputedField,
  ComputedScope,
  ResolvedCalculation,
} from './execution-types.js';
import { AnalyticalIncompleteError } from './execution-types.js';

type Failure = Exclude<ComputedField, { status: 'available' }>;

export function invalidate(
  rows: readonly CandidateRow[],
  names: readonly string[],
  failure: Failure,
): void {
  for (const row of rows)
    for (const name of names) {
      const cell = row.fields[name]!;

      if (cell.status === 'pending' || cell.status === 'available')
        row.fields[name] = Object.freeze({ ...failure });
    }
}

function instant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/**
 * Frame validation fails the statement; scalar validation withdraws only the
 * affected alias; an arithmetic check withdraws only that field on that object.
 */
export function mergeBatch(input: {
  batch: CalculationBatch;
  result: DatasetExecution;
  rows: readonly CandidateRow[];
  failed: Set<string>;
  computedAt: string;
}): void {
  const { batch, result, rows, failed } = input;
  const malformed =
    !result ||
    !instant(result.readAt) ||
    (result.modifiedAt !== undefined && !instant(result.modifiedAt)) ||
    !Array.isArray(result.rows) ||
    result.rows.length !== batch.rowIndexes.length ||
    Array.from(result.rows).some(
      (row, i) =>
        !row ||
        row.slot !== i ||
        !Array.isArray(row.values) ||
        row.values.length !== batch.fields.length ||
        Array.from(row.values).some(
          (value) =>
            value !== null &&
            !['string', 'number', 'boolean', 'bigint'].includes(typeof value),
        ) ||
        !Array.isArray(row.checks) ||
        row.checks.length !== batch.fields.length ||
        Array.from(row.checks).some(
          (check) =>
            typeof (check as { arithmeticFailed?: unknown } | null)
              ?.arithmeticFailed !== 'boolean',
        ),
    );

  if (malformed) {
    for (const field of batch.fields) failed.add(field.name);

    invalidate(
      rows,
      batch.fields.map((field) => field.name),
      { status: 'unavailable', reason: 'invalid-result' },
    );

    return;
  }

  for (const [column, field] of batch.fields.entries()) {
    if (failed.has(field.name)) continue;

    const values = new Map<number, ReturnType<typeof encodeAnalyticalValue>>();
    const failedCells: number[] = [];

    try {
      for (const [slot, rowIndex] of batch.rowIndexes.entries()) {
        if (!batch.query.slots[slot]!.valid[column]) continue;

        // Read the check before the placeholder can be encoded as a null.
        if (result.rows[slot]!.checks[column]!.arithmeticFailed) {
          failedCells.push(rowIndex);
          continue;
        }

        values.set(
          rowIndex,
          encodeAnalyticalValue(
            result.rows[slot]!.values[column],
            field.expression.aggregate.result,
          ),
        );
      }
    } catch {
      failed.add(field.name);
      invalidate(rows, [field.name], {
        status: 'unavailable',
        reason: 'invalid-result',
      });
      continue;
    }

    invalidate(
      failedCells.map((rowIndex) => rows[rowIndex]!),
      [field.name],
      { status: 'unavailable', reason: 'execution-failed', retryable: false },
    );

    for (const [rowIndex, value] of values) {
      const cell = rows[rowIndex]!.fields[field.name]!;

      if (cell.status !== 'pending') continue;

      rows[rowIndex]!.fields[field.name] = Object.freeze({
        status: 'available',
        value,
        computedAt: input.computedAt,
        columns: Object.freeze([...field.expression.columns]),
        input: Object.freeze({
          associationId: field.expression.association.id,
          datasetId: field.expression.association.datasetDefinitionId,
          bindingRevision: batch.binding.bindingRevision,
          readAt: result.readAt,
          ...(result.modifiedAt === undefined
            ? {}
            : { modifiedAt: result.modifiedAt }),
        }),
        dependencies: cell.dependencies,
      });
    }
  }
}

export function finishScope(
  fields: readonly ResolvedCalculation[],
  rows: readonly CandidateRow[],
  requireComplete: boolean,
): ComputedScope {
  const failures: Record<string, Failure> = {};

  for (const row of rows)
    for (const field of fields) {
      const cell = row.fields[field.name]!;

      if (cell.status === 'pending')
        throw new Error('Unsettled analytical result');

      if (
        cell.status !== 'available' &&
        (field.required || (requireComplete && field.project))
      )
        Object.defineProperty(failures, field.name, {
          enumerable: true,
          configurable: true,
          value: cell,
        });
    }

  if (Object.keys(failures).length)
    throw new AnalyticalIncompleteError(Object.freeze(failures));

  return Object.freeze({
    rows: new Map(
      rows.map((row) => [
        row.id,
        Object.freeze(row.fields as Record<string, ComputedField>),
      ]),
    ),
    results: Object.freeze(
      Object.fromEntries(
        fields
          .filter((field) => field.project)
          .map((field) => [
            field.name,
            Object.freeze({ ...field.expression.aggregate.result }),
          ]),
      ),
    ),
  });
}
