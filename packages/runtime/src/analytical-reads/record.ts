import type { AnalyticalReadMode, OrdinaryReadResult } from './types.js';
import { ReadError } from '@relate/protocol';
import type {
  FullObjectRecord,
  ReadRequest,
  FieldEvidence,
} from '@relate/protocol';
import { analyticalSchemaType } from 'relate/model';
import type { Manifest } from 'relate/model';
import { parseAnalyticalValue } from 'relate/analytics';
import { project } from '../reads/index.js';
import { summarize } from '../reads/index.js';
import type { predicateMatcher } from '../reads/index.js';
import {
  revalidateFields,
  AnalyticalIncompleteError,
  captureCalculations,
} from '../analytics/index.js';
import type {
  AuthorizedCandidate,
  ComputedField,
  ComputedScope,
  ActorAssociations,
} from '../analytics/index.js';
import type { CalculationCapture } from '../analytics/index.js';

type ObjectModel = Manifest['objects'][number];

export interface RevalidatedRecord {
  readonly record: FullObjectRecord;
  readonly fields: Readonly<Record<string, ComputedField>>;
  readonly at: number;
}

/** Preserve the read instant while deriving private, typed correlation dependencies. */
export function createMaterializer(
  object: ObjectModel,
  dependencies: readonly string[],
  maxAgeMs: number,
) {
  return (result: FullObjectRecord, at: number): AuthorizedCandidate => ({
    id: result.id,
    dependencies: Object.fromEntries(
      dependencies.map((propertyId) => {
        const property = object.properties.find(
          (property) => property.id === propertyId,
        )!;
        const evidence = result.meta.fields[property.name] ?? {
          status: 'unavailable' as const,
        };
        const type = analyticalSchemaType(property.schema);
        let value;

        const policyFresh =
          evidence.status !== 'available' ||
          evidence.source !== 'source' ||
          (at - Date.parse(evidence.observedAt) >= 0 &&
            at - Date.parse(evidence.observedAt) <= maxAgeMs);

        if (
          type &&
          policyFresh &&
          evidence.status === 'available' &&
          Object.hasOwn(result.data, property.name)
        ) {
          try {
            value = parseAnalyticalValue(result.data[property.name], type);
          } catch {
            /* Unusable dependency. */
          }
        }

        return [propertyId, { evidence, ...(value ? { value } : {}) }];
      }),
    ),
  });
}

/** Re-read authorization and dependencies, then project only public selected fields. */
export function createRecordFinalizer(options: {
  object: ObjectModel;
  selection: readonly string[];
  selectedOrdinary: readonly string[];
  controls: ReadRequest;
  request: ReadRequest;
  computed: ComputedScope;
  required: readonly string[];
  mode: AnalyticalReadMode;
  operation: string;
  signal: AbortSignal;
  clock(): number;
  materialize: ReturnType<typeof createMaterializer>;
  associations(): ActorAssociations;
  filter: Pick<ReturnType<typeof predicateMatcher>, 'matches'>;
  summary?: CalculationCapture;
  read(id: string): Promise<OrdinaryReadResult>;
}) {
  const {
    object,
    selection,
    selectedOrdinary,
    controls,
    request,
    computed,
    required,
    mode,
    operation,
    signal,
    clock,
    materialize,
    associations,
    filter,
    summary,
    read,
  } = options;
  const revalidate = async (
    record: FullObjectRecord,
    previous = computed.rows.get(record.id)!,
    reader = read,
  ): Promise<RevalidatedRecord | undefined> => {
    signal.throwIfAborted();
    const { result: current, recheckAuthorization } = await reader(record.id);

    signal.throwIfAborted();

    if (current.status !== 'ok') return undefined;

    const visible = await recheckAuthorization();

    signal.throwIfAborted();

    if (!visible) return undefined;

    const at = clock();

    if (!filter.matches(record.id, current, at)) return undefined;

    const fresh = project(record.id, current, selection, controls, at);
    const fields = revalidateFields(
      previous,
      materialize(fresh, at),
      associations(),
    );

    captureCalculations(summary, (capture) =>
      capture.results(fields, previous),
    );
    const failures = Object.fromEntries(
      [
        ...new Set([
          ...required,
          ...(mode === 'rank-scope' && request.requireComplete
            ? Object.keys(computed.results)
            : []),
        ]),
      ].flatMap((name) => {
        const field = fields[name]!;

        return field.status === 'available' ? [] : [[name, field]];
      }),
    );

    if (Object.keys(failures).length)
      throw new AnalyticalIncompleteError(failures);

    return { record: current, fields, at };
  };
  const projectRecord = ({
    record,
    fields,
    at,
  }: RevalidatedRecord): FullObjectRecord => {
    const output = project(
      record.id,
      { status: 'ok', ...record },
      selectedOrdinary,
      { ...request, requireComplete: false },
      at,
    );

    for (const [name, field] of Object.entries(fields)) {
      if (!Object.hasOwn(computed.results, name)) continue;

      if (field.status !== 'available') {
        output.meta.fields[name] = field;
        continue;
      }

      output.data[name] = field.value;
      output.meta.fields[name] = {
        status: 'available',
        source: 'computed',
        freshness: 'unverified',
        computedAt: field.computedAt,
        inputs: [field.input],
        coverage: 'complete',
        dependencies: Object.fromEntries(
          Object.entries(field.dependencies).map(([propertyId, dependency]) => [
            object.properties.find((property) => property.id === propertyId)!
              .name,
            dependency.evidence,
          ]),
        ),
      } satisfies FieldEvidence;
    }

    Object.assign(
      output.meta,
      summarize(output.meta.fields, output.meta.warnings),
      { computed: computed.results },
    );

    if (request.requireComplete && output.meta.completeness === 'partial')
      throw new ReadError('incomplete', {
        operation,
        issues: Object.entries(output.meta.fields)
          .filter(
            ([, field]) =>
              field.status === 'forbidden' || field.status === 'unavailable',
          )
          .map(([name, field]) => ({
            path: [name],
            problem: 'invalid-value',
            message:
              field.status === 'unavailable' && field.reason
                ? field.reason
                : field.status,
          })),
      });

    signal.throwIfAborted();

    return output;
  };

  return { revalidate, projectRecord };
}
