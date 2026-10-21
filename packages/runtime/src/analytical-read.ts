import type { QueryContext } from './queries/index.js';
import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  QueryRequest,
  FullPageResult,
  FullObjectRecord,
  FullObjectResult,
  FieldEvidence,
  RequestIssue,
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
  filterableProperties,
} from './authorization/index.js';
import type { OperationScope } from './activity/index.js';
import {
  prepareCompute,
  preparedBindingRevisions,
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
  compileWhere,
  predicateMatcher,
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
export function createAnalyticalReads(options: {
  readonly manifest: Manifest;
  readonly read: OrdinaryRead;
  readonly query: (
    attempt: OperationScope,
    principal: Principal,
    type: string,
    request: QueryRequest,
    context?: QueryContext,
  ) => Promise<FullPageResult>;
  readonly analytics?: AnalyticalReadOptions;
  readonly clock: () => number;
}) {
  const run = async (
    kind: 'get' | 'query',
    attempt: OperationScope,
    principal: Principal,
    type: string,
    id: string | undefined,
    input: QueryRequest,
  ): Promise<FullObjectResult | FullPageResult> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return kind === 'get'
        ? options.read(attempt, principal, type, id!, input)
        : options.query(attempt, principal, type, input);

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
      return kind === 'get'
        ? options.read(attempt, principal, type, id!, input)
        : options.query(attempt, principal, type, input);

    const operation = operationName(options.manifest, principal, type, kind);
    const { compute, ...ordinary } = input;

    rejectIssues(operation, kind, requestIssues(ordinary, kind));

    if (!object || !allowsObject(principal, policy))
      return kind === 'get'
        ? { status: 'not-found' }
        : options.query(attempt, principal, type, ordinary);

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

    const { limit, cursor, where, ...request } = structuredClone(ordinary);
    const filterIssues: RequestIssue[] = [];
    const predicates =
      kind === 'query'
        ? compileWhere(
            object.apiName,
            () => filterableProperties(options.manifest, principal, object),
            where ?? {},
            filterIssues,
          )
        : [];

    rejectIssues(operation, kind, filterIssues);
    const filter = predicateMatcher(predicates, request, options.clock);
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
    const selection = [
      ...new Set([...selectedOrdinary, ...dependencyNames, ...filter.names]),
    ];
    const policyMaxAgeMs = policy.read.where
      ? policy.read.evidenceMaxAgeMs
      : 60_000;
    const controls: ReadRequest = {
      ...request,
      ...(request.select === undefined ? {} : { select: selection }),
      requireComplete: false,
      evidence: 'full',
      maxAgeMs: Math.min(request.maxAgeMs ?? 60_000, policyMaxAgeMs),
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
      result: FullObjectRecord,
      at: number,
    ): AuthorizedCandidate => ({
      id: result.id,
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
              at - Date.parse(evidence.observedAt) <= policyMaxAgeMs);

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
      let page: FullPageResult;

      if (kind === 'get') {
        const initial = await options.read(
          attempt,
          principal,
          type,
          id!,
          controls,
        );

        controller.signal.throwIfAborted();

        if (initial.status !== 'ok') return initial;

        page = { data: [initial], meta: { exhausted: true } };
      } else {
        page = await options.query(
          attempt,
          principal,
          type,
          {
            ...request,
            ...(request.select === undefined ? {} : { select: selection }),
            requireComplete: false,
            evidence: 'full',
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(where === undefined ? {} : { where }),
          },
          {
            signal: controller.signal,
            candidateControls: { maxAgeMs: controls.maxAgeMs!, stale: 'allow' },
            cursorScope: {
              compute: compute ?? {},
              select: request.select ?? null,
              requireComplete: request.requireComplete ?? false,
              bindings: preparedBindingRevisions(
                prepared,
                (id) => analytics.binding(id).bindingRevision,
              ),
            },
          },
        );
      }

      controller.signal.throwIfAborted();
      const candidates = page.data.map((record) => {
        const at = options.clock();

        return materialize(
          project(
            record.id,
            { status: 'ok', ...record },
            selection,
            controls,
            at,
          ),
          at,
        );
      });
      const computed = await computeFields({
        prepared,
        candidates,
        binding: analytics.binding,
        signal: controller.signal,
        clock: options.clock,
      });
      const data: FullObjectRecord[] = [];

      for (const record of page.data) {
        const id = record.id;

        controller.signal.throwIfAborted();
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

        if (current.status !== 'ok') continue;

        const visible = await allowed();

        controller.signal.throwIfAborted();

        if (!visible) continue;

        controller.signal.throwIfAborted();
        const finalizedAt = options.clock();

        if (!filter.matches(id, current, finalizedAt)) continue;

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
                  field.status === 'forbidden' ||
                  field.status === 'unavailable',
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

        data.push(output);
      }

      controller.signal.throwIfAborted();

      return kind === 'get'
        ? data[0]
          ? { status: 'ok', ...data[0] }
          : { status: 'not-found' }
        : { data, meta: page.meta };
    } finally {
      if (timer !== undefined) clearTimeout(timer);

      analytics.signal.removeEventListener('abort', retire);
    }
  };

  return {
    get: (
      attempt: OperationScope,
      principal: Principal,
      type: string,
      id: string,
      input: ReadRequest,
    ) =>
      run(
        'get',
        attempt,
        principal,
        type,
        id,
        input,
      ) as Promise<FullObjectResult>,
    query: (
      attempt: OperationScope,
      principal: Principal,
      type: string,
      input: QueryRequest,
    ) =>
      run(
        'query',
        attempt,
        principal,
        type,
        undefined,
        input,
      ) as Promise<FullPageResult>,
  };
}
