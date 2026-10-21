import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  FullObjectResult,
  FieldEvidence,
} from '@relate/protocol';
import type { Manifest } from 'relate/model';
import { analyticalSchemaType } from 'relate/model';
import { parseAnalyticalValue } from 'relate/analytics';
import type { SqlParser } from 'relate/analytics';
import type { Principal } from './authorization/index.js';
import {
  actorAssociations,
  analyticalDeclarations,
  allowsField,
  allowsObject,
  operationName,
} from './authorization/index.js';
import type { OperationScope } from './activity/index.js';
import {
  prepareCompute,
  computeFields,
  revalidateFields,
  AnalyticalPreparationError,
} from './analytics/index.js';
import type {
  AnalyticalBinding,
  AuthorizedCandidate,
} from './analytics/index.js';
import {
  project,
  requestIssues,
  rejectIssues,
  summarize,
} from './reads/index.js';

export interface AnalyticalReadOptions {
  readonly parser: SqlParser;
  readonly binding: (datasetId: string) => AnalyticalBinding;
  readonly signal: AbortSignal;
}

type OrdinaryRead = (
  attempt: OperationScope,
  principal: Principal,
  type: string,
  id: string,
  request: ReadRequest,
  requiredReference?: string,
  capture?: (allowed: () => Promise<boolean>) => void,
) => Promise<FullObjectResult>;

/** Composition owns ordinary reads and policy; analytics owns pure preparation/execution. */
export function createAnalyticalRead(options: {
  readonly manifest: Manifest;
  readonly read: OrdinaryRead;
  readonly analytics?: AnalyticalReadOptions;
  readonly clock: () => number;
}) {
  return async (
    attempt: OperationScope,
    principal: Principal,
    type: string,
    id: string,
    input: ReadRequest,
  ): Promise<FullObjectResult> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return options.read(attempt, principal, type, id, input);

    const started = performance.now();
    const object = options.manifest.objects.find((entry) => entry.id === type);
    const policy = options.manifest.policies[type];
    const selected =
      input?.select ??
      (object
        ? [...object.properties, ...(object.calculations ?? [])]
            .filter(
              (property) =>
                policy && allowsField(principal, policy, property.access),
            )
            .map((property) => property.name)
        : []);
    const calculated =
      object?.calculations?.filter(
        (property) =>
          Array.isArray(selected) && selected.includes(property.name),
      ) ?? [];

    if (input?.compute === undefined && !calculated.length)
      return options.read(attempt, principal, type, id, input);

    const operation = operationName(options.manifest, principal, type, 'get');
    const { compute, ...ordinary } = input;

    rejectIssues(operation, 'get', requestIssues(ordinary, 'get'));

    if (!object || !allowsObject(principal, policy))
      return { status: 'not-found' };

    const analytics = options.analytics;

    if (!analytics)
      throw new ReadError('invalid-request', {
        operation,
        issues: [
          {
            path: input.compute === undefined ? ['select'] : ['compute'],
            problem: 'not-supported',
            message:
              'Analytical reads require a configured analytical runtime.',
          },
        ],
      });

    const request = structuredClone(ordinary);
    const associations = actorAssociations(options.manifest, principal, object);
    let prepared;

    try {
      prepared = prepareCompute({
        parser: analytics.parser,
        associations,
        declarations: analyticalDeclarations(options.manifest, object),
        request: {
          compute,
          declarations: calculated.map((property) => ({
            name: property.name,
            definitionId: property.id,
            sql: property.sql,
            readable: allowsField(principal, policy, property.access),
            project: true,
            required: false,
          })),
        },
      });
    } catch (error) {
      if (!(error instanceof AnalyticalPreparationError)) throw error;

      throw new ReadError('invalid-request', {
        operation,
        issues: error.issues.map((issue) => {
          const alias = issue.path?.[1];
          const expression =
            alias && compute && Object.hasOwn(compute, alias)
              ? compute[alias]
              : undefined;
          const prefix =
            issue.at && expression
              ? expression.sql.slice(0, issue.at.start)
              : undefined;

          return {
            path: issue.path ?? ['compute'],
            problem: issue.problem,
            message: issue.message,
            ...(prefix === undefined
              ? {}
              : {
                  location: {
                    line: prefix.split('\n').length,
                    column: prefix.length - prefix.lastIndexOf('\n'),
                  },
                }),
          };
        }),
      });
    }

    const selectedOrdinary = selected.filter(
      (name) => !calculated.some((property) => property.name === name),
    );
    const dependencyNames = prepared.dependencies.map(
      (id) => object.properties.find((property) => property.id === id)!.name,
    );
    const selection = [...new Set([...selectedOrdinary, ...dependencyNames])];
    const controls: ReadRequest = {
      ...request,
      ...(request.select === undefined ? {} : { select: selection }),
      requireComplete: false,
      evidence: 'full',
      maxAgeMs: Math.min(
        request.maxAgeMs ?? 60_000,
        policy.read.evidenceMaxAgeMs,
      ),
    };
    const controller = new AbortController();
    const retire = () => controller.abort(new ReadError('runtime-retired'));

    analytics.signal.addEventListener('abort', retire, { once: true });

    if (analytics.signal.aborted) retire();

    const remaining =
      request.timeoutMs === undefined
        ? undefined
        : request.timeoutMs - (performance.now() - started);

    if (remaining !== undefined && remaining <= 0)
      controller.abort(new ReadError('unavailable'));

    const timer =
      remaining === undefined
        ? undefined
        : setTimeout(
            () => controller.abort(new ReadError('unavailable')),
            Math.max(0, remaining),
          );
    const materialize = (
      result: Extract<FullObjectResult, { status: 'ok' }>,
      at: number,
    ): AuthorizedCandidate => ({
      id,
      dependencies: Object.fromEntries(
        prepared.dependencies.map((propertyId) => {
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
              at - Date.parse(evidence.observedAt) <=
                policy.read.evidenceMaxAgeMs);

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

    try {
      controller.signal.throwIfAborted();
      const initial = await options.read(
        attempt,
        principal,
        type,
        id,
        controls,
      );

      controller.signal.throwIfAborted();

      if (initial.status !== 'ok') return initial;

      const initialAt = options.clock();
      const first = {
        status: 'ok' as const,
        ...project(id, initial, selection, controls, initialAt),
      };
      const computed = await computeFields({
        prepared,
        candidates: [materialize(first, initialAt)],
        binding: analytics.binding,
        signal: controller.signal,
        clock: options.clock,
      });
      let allowed = async () => false;
      const current = await options.read(
        attempt,
        principal,
        type,
        id,
        { ...controls, refresh: false, stale: 'allow' },
        undefined,
        (check) => {
          allowed = check;
        },
      );

      controller.signal.throwIfAborted();

      if (current.status !== 'ok') return current;

      const visible = await allowed();

      controller.signal.throwIfAborted();

      if (!visible) return { status: 'not-found' };

      controller.signal.throwIfAborted();
      const finalizedAt = options.clock();
      const fresh = {
        status: 'ok' as const,
        ...project(id, current, selection, controls, finalizedAt),
      };
      const checked = revalidateFields(
        computed.rows.get(id)!,
        materialize(fresh, finalizedAt),
        actorAssociations(options.manifest, principal, object),
      );
      const output = project(
        id,
        current,
        selectedOrdinary,
        { ...request, requireComplete: false },
        finalizedAt,
      );

      for (const [name, field] of Object.entries(checked)) {
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
            Object.entries(field.dependencies).map(
              ([propertyId, dependency]) => [
                object.properties.find(
                  (property) => property.id === propertyId,
                )!.name,
                dependency.evidence,
              ],
            ),
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

      controller.signal.throwIfAborted();

      return { status: 'ok', ...output };
    } finally {
      if (timer !== undefined) clearTimeout(timer);

      analytics.signal.removeEventListener('abort', retire);
    }
  };
}
