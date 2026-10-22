import { encodeAnalyticalValue, parseAnalyticalValue } from 'relate/analytics';
import type { LogicalType } from 'relate/analytics';
import type {
  AuthorizedDatasetQuery,
  ResolvedOperand,
  ResolvedPredicate,
  ResolvedAggregate,
  TypedValue,
} from 'relate/connectors';
import type {
  ResolvedCalculation,
  AuthorizedCandidate,
  ComputedField,
  AnalyticalBinding,
} from './execution-types.js';
import { AnalyticalPreparationError } from './types.js';

export type Cell =
  | Exclude<ComputedField, { status: 'available' }>
  | {
      readonly status: 'pending';
      readonly dependencies: AuthorizedCandidate['dependencies'];
    }
  | Extract<ComputedField, { status: 'available' }>;

export interface CandidateRow {
  readonly id: string;
  readonly fields: Record<string, Cell>;
}

export interface CalculationBatch {
  readonly fields: readonly ResolvedCalculation[];
  readonly rowIndexes: readonly number[];
  readonly query: AuthorizedDatasetQuery;
  readonly binding: AnalyticalBinding;
}

function matching(value: TypedValue, type: LogicalType): boolean {
  return (
    value.type === type.type &&
    (type.type !== 'timestamp' ||
      (value.type === 'timestamp' && type.precision === value.precision))
  );
}

function usable(
  candidate: AuthorizedCandidate,
  dependency: ResolvedCalculation['expression']['dependencies'][number],
): TypedValue | undefined {
  const field = Object.hasOwn(candidate.dependencies, dependency.id)
    ? candidate.dependencies[dependency.id]
    : undefined;

  if (
    field?.evidence.status !== 'available' ||
    !field.value ||
    field.value.value === null ||
    !matching(field.value, dependency.type)
  )
    return undefined;

  try {
    return parseAnalyticalValue(
      encodeAnalyticalValue(field.value.value, {
        ...dependency.type,
        nullable: false,
      }),
      dependency.type,
    );
  } catch {
    return undefined;
  }
}

export function initializeRows(
  fields: readonly ResolvedCalculation[],
  candidates: readonly AuthorizedCandidate[],
): CandidateRow[] {
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !==
    candidates.length
  )
    throw new Error('Duplicate analytical candidate');

  return candidates.map((candidate) => ({
    id: candidate.id,
    fields: Object.fromEntries(
      fields.map((field) => {
        const expression = field.expression;

        if (!field.readable || expression.forbidden)
          return [field.name, { status: 'forbidden' }];

        const dependencies: Record<
          string,
          AuthorizedCandidate['dependencies'][string]
        > = {};
        let unavailable = expression.correlationForbidden;
        let forbidden = false;

        for (const dependency of expression.dependencies) {
          const supplied = Object.hasOwn(candidate.dependencies, dependency.id)
            ? candidate.dependencies[dependency.id]
            : undefined;

          if (
            !dependency.correlation &&
            supplied?.evidence.status === 'forbidden'
          )
            forbidden = true;

          const value = usable(candidate, dependency);

          if (!value) unavailable = true;
          else
            Object.defineProperty(dependencies, dependency.id, {
              enumerable: true,
              value: Object.freeze({
                value: Object.freeze(value),
                evidence: structuredClone(supplied!.evidence),
              }),
            });
        }

        const cell: Cell = forbidden
          ? { status: 'forbidden' }
          : unavailable
            ? { status: 'unavailable', reason: 'correlation-unavailable' }
            : { status: 'pending', dependencies: Object.freeze(dependencies) };

        return [field.name, cell];
      }),
    ),
  }));
}

function remap(
  aggregate: ResolvedAggregate,
  indexes: readonly number[],
): ResolvedAggregate {
  const operand = (value: ResolvedOperand): ResolvedOperand =>
    value.kind === 'key' ? { ...value, key: indexes[value.key]! } : value;
  const predicate = (value: ResolvedPredicate): ResolvedPredicate =>
    value.kind === 'compare'
      ? { ...value, left: operand(value.left), right: operand(value.right) }
      : value.kind === 'null'
        ? { ...value, value: operand(value.value) }
        : { ...value, args: value.args.map(predicate) };

  return {
    ...aggregate,
    argument: aggregate.argument === '*' ? '*' : operand(aggregate.argument),
    ...(aggregate.predicate
      ? { predicate: predicate(aggregate.predicate) }
      : {}),
  };
}

/** No I/O; one statement per association and chunk, with per-aggregate validity masks. */
export function planBatches(input: {
  fields: readonly ResolvedCalculation[];
  rows: readonly CandidateRow[];
  binding(datasetId: string): AnalyticalBinding;
  maxSlots: number;
  preflight?: boolean;
}): CalculationBatch[] {
  if (!Number.isSafeInteger(input.maxSlots) || input.maxSlots < 1)
    throw new Error('Invalid analytical batch limit');

  const groups = new Map<string, ResolvedCalculation[]>();

  for (const field of input.fields) {
    if (
      input.preflight
        ? !field.readable ||
          field.expression.forbidden ||
          field.expression.correlationForbidden
        : !input.rows.some(
            (row) => row.fields[field.name]!.status === 'pending',
          )
    )
      continue;

    const id = field.expression.association.id;
    const group = groups.get(id) ?? [];

    group.push(field);
    groups.set(id, group);
  }

  const batches: CalculationBatch[] = [];

  for (const fields of groups.values()) {
    const association = fields[0]!.expression.association;
    const binding = input.binding(association.datasetDefinitionId);
    const dependencies: { id: string; type: LogicalType }[] = [];
    const index = (id: string, type: LogicalType) => {
      let at = dependencies.findIndex((value) => value.id === id);

      if (at < 0) {
        at = dependencies.length;
        dependencies.push({ id, type });
      }

      return at;
    };

    // Keep correlation keys first, regardless of alias ordering and optional self keys.
    for (const pair of association.on) {
      const dependency = fields[0]!.expression.dependencies.find(
        (dependency) => dependency.id === pair.propertyDefinitionId,
      )!;

      index(dependency.id, dependency.type);
    }

    const aggregates = fields.map((field) =>
      remap(
        field.expression.aggregate,
        field.expression.dependencies.map((dependency) =>
          index(dependency.id, dependency.type),
        ),
      ),
    );
    const base: Omit<AuthorizedDatasetQuery, 'slots'> = {
      resource: binding.resource,
      keys: dependencies.map(({ type }) => ({ type })),
      aggregates,
      correlation: association.on.map((pair) => ({
        column: association.columns.find(
          (column) => column.id === pair.columnDefinitionId,
        )!.name,
        key: dependencies.findIndex(
          (dependency) => dependency.id === pair.propertyDefinitionId,
        ),
      })),
    };
    const budget = binding.connector.parameterBudget(base);
    const limit = binding.connector.limits.maxParameters;

    if (
      ![budget.fixed, budget.perSlot, limit].every(Number.isSafeInteger) ||
      budget.fixed < 0 ||
      budget.perSlot < 1 ||
      limit < 1
    )
      throw new Error('Invalid connector parameter budget');

    const size = Math.min(
      input.maxSlots,
      Math.floor((limit - budget.fixed) / budget.perSlot),
    );

    if (size < 1)
      throw new AnalyticalPreparationError([
        {
          problem: 'not-supported',
          message:
            'The analytical statement parameter limit cannot fit one object.',
        },
      ]);

    const rowIndexes = input.rows.flatMap((row, i) =>
      fields.some((field) => row.fields[field.name]!.status === 'pending')
        ? [i]
        : [],
    );

    for (let offset = 0; offset < rowIndexes.length; offset += size) {
      const indexes = rowIndexes.slice(offset, offset + size);
      const slots = indexes.map((i) => {
        const row = input.rows[i]!;
        const usableValues = new Map<string, TypedValue>();
        const valid = fields.map((field) => {
          const cell = row.fields[field.name]!;

          if (cell.status !== 'pending') return false;

          for (const [id, dependency] of Object.entries(cell.dependencies))
            usableValues.set(id, dependency.value!);

          return true;
        });

        return {
          values: dependencies.map(
            (dependency) =>
              usableValues.get(dependency.id) ?? {
                ...dependency.type,
                value: null,
              },
          ),
          valid,
        };
      });

      batches.push({
        fields,
        binding,
        rowIndexes: indexes,
        query: { ...base, slots },
      });
    }
  }

  return batches;
}
