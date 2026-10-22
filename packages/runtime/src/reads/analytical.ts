import { readQueryCandidates, rankPage } from './analytical-query.js';
import { selectedProperties, selectionIssues } from './index.js';
import {
  createMaterializer,
  createRecordFinalizer,
} from './analytical-record.js';
import type { Validated } from './analytical-record.js';
import { mapReads } from './index.js';
import type { QueryContext, QueryCursors } from '../queries/index.js';
import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  QueryRequest,
  FullPageResult,
  FullObjectRecord,
  FullObjectResult,
  RequestIssue,
} from '@relate/protocol';
import type { Manifest } from 'relate/model';
import type { SqlParser, AnalyticalLimits } from 'relate/analytics';
import type { ReadExecution } from './index.js';
import type { Principal } from '../authorization/index.js';
import {
  actorAssociations,
  analyticalDeclarations,
  allowsField,
  allowsObject,
  operationName,
  filterableProperties,
} from '../authorization/index.js';
import type { OperationScope } from '../activity/index.js';
import { operationDiagnostics } from '../activity/index.js';
import {
  createAnalyticalTimings,
  createCalculationSummary,
  beginTiming,
  prepareCompute,
  preparedBindingRevisions,
  computeFields,
  validatePreparedCapacity,
  AnalyticalPreparationError,
  resolveAnalyticalLimits,
  prepareComputedOrder,
  AnalyticalIncompleteError,
} from '../analytics/index.js';
import type {
  AnalyticalBinding,
  ComputedPosition,
} from '../analytics/index.js';
import {
  project,
  requestIssues,
  rejectIssues,
  compileWhere,
  predicateMatcher,
  cursorIssue,
} from './index.js';

export interface AnalyticalReadOptions {
  readonly limits?: AnalyticalLimits;
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
  execution?: ReadExecution,
) => Promise<FullObjectResult>;

/** Composition owns ordinary reads and policy; analytics owns pure preparation/execution. */
export function createAnalyticalReads(options: {
  readonly manifest: Manifest;
  readonly cursors: QueryCursors;
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
  const limits = resolveAnalyticalLimits(options.analytics?.limits);
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
      input.select ??
      (object
        ? selectedProperties(
            [...object.properties, ...(object.calculations ?? [])],
            undefined,
            (property) =>
              Boolean(
                policy && allowsField(principal, policy, property.access),
              ),
          )
        : []);
    const orderedNames = Array.isArray(input.orderBy)
      ? input.orderBy.flatMap((entry) =>
          typeof entry?.field === 'string' ? [entry.field] : [],
        )
      : [];
    const requestedFilters =
      kind === 'query' && input.where && typeof input.where === 'object'
        ? Object.keys(input.where)
        : [];
    const calculated =
      object?.calculations?.filter(
        (property) =>
          (Array.isArray(selected) && selected.includes(property.name)) ||
          requestedFilters.includes(property.name) ||
          orderedNames.includes(property.name),
      ) ?? [];

    if (
      input.compute === undefined &&
      !calculated.length &&
      (input.orderBy === undefined ||
        (Array.isArray(input.orderBy) && input.orderBy.length === 0))
    )
      return kind === 'get'
        ? options.read(attempt, principal, type, id!, input)
        : options.query(
            attempt,
            principal,
            type,
            Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'orderBy'),
            ),
          );

    const diagnostics = operationDiagnostics(attempt);
    const timings = diagnostics ? createAnalyticalTimings() : undefined;
    let summary: ReturnType<typeof createCalculationSummary> | undefined;

    if (diagnostics && timings)
      diagnostics.analytical = () => {
        const captured = summary?.snapshot();

        return {
          ...timings.snapshot(),
          ...(captured ? { summary: captured } : {}),
        };
      };

    const measure = async <T>(
      stage: Parameters<typeof beginTiming>[1],
      run: () => Promise<T>,
    ): Promise<T> => {
      const end = beginTiming(timings, stage);

      try {
        return await run();
      } finally {
        end();
      }
    };
    const endPreparation = beginTiming(timings, 'preparation');

    try {
      const operation = operationName(options.manifest, principal, type, kind);
      const { compute, orderBy, ...ordinary } = input;

      rejectIssues(
        operation,
        kind,
        requestIssues(
          { ...ordinary, ...(orderBy === undefined ? {} : { orderBy }) },
          kind,
        ),
      );

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

      const {
        limit,
        cursor,
        where: allWhere,
        ...request
      } = structuredClone(ordinary);
      const computedNames = new Set([
        ...Object.keys(compute ?? {}),
        ...(object.calculations ?? []).map((property) => property.name),
      ]);
      const where = Object.fromEntries(
        Object.entries(allWhere ?? {}).filter(
          ([name]) => !computedNames.has(name),
        ),
      );
      const computedWhere = Object.fromEntries(
        Object.entries(allWhere ?? {}).filter(([name]) =>
          computedNames.has(name),
        ),
      );
      const required = [
        ...new Set([
          ...Object.keys(computedWhere),
          ...orderedNames.filter((name) => computedNames.has(name)),
        ]),
      ];
      const scopeFirst =
        kind === 'query' &&
        (required.length > 0 || (Array.isArray(orderBy) && orderBy.length > 0));
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
      const associations = actorAssociations(
        options.manifest,
        principal,
        object,
      );
      let prepared;
      let ordering;

      if (diagnostics)
        summary = createCalculationSummary({
          computedFilter: Object.keys(computedWhere).length > 0,
          computedOrder: orderedNames.length > 0,
        });

      try {
        prepared = prepareCompute({
          ...(summary ? { activity: summary } : {}),
          parser: analytics.parser,
          limits,
          associations,
          declarations: analyticalDeclarations(options.manifest, object),
          request: {
            compute,
            requiredAliases: required.filter(
              (name) => compute && Object.hasOwn(compute, name),
            ),
            declarations: calculated.map((property) => ({
              name: property.name,
              definitionId: property.id,
              sql: property.sql,
              readable: allowsField(principal, policy, property.access),
              project: selected.includes(property.name),
              required: required.includes(property.name),
            })),
          },
        });
        validatePreparedCapacity(
          prepared,
          analytics.binding,
          limits.maxKeysPerStatement,
        );
        ordering = prepareComputedOrder({
          where: computedWhere,
          orderBy,
          types: prepared.types,
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

      rejectIssues(
        operation,
        kind,
        selectionIssues(request.select, [...selectedOrdinary, ...filter.names]),
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

      const computeSnapshot = structuredClone(compute ?? {});
      const bindingRevisions = preparedBindingRevisions(
        prepared,
        (id) => analytics.binding(id).bindingRevision,
      );
      const { evidence: _evidence, ...cursorRequest } = request;
      const scopeCursor = options.cursors(
        type,
        principal,
        { ...cursorRequest, where: allWhere ?? {}, limit: limit ?? 25 },
        {
          path: 'computed-scope',
          compute: computeSnapshot,
          orderBy: orderBy ?? [],
          bindings: bindingRevisions,
        },
      );
      let position: ComputedPosition | undefined;

      if (scopeFirst && cursor !== undefined) {
        try {
          position = ordering.parsePosition(
            scopeCursor.decode(cursor, operation),
          );
        } catch {
          throw new ReadError('invalid-request', {
            operation,
            issues: [cursorIssue()],
          });
        }
      }

      endPreparation();
      const controller = new AbortController();
      let sourceCalls = 0;
      const execution: ReadExecution = {
        expandedSelection: true,
        signal: controller.signal,
        beforeSourceCall() {
          controller.signal.throwIfAborted();

          if (sourceCalls >= limits.maxSourceCalls) {
            controller.abort(
              new ReadError('resource-exhausted', {
                operation,
                issues: [
                  {
                    path: [],
                    problem: 'limit-exceeded',
                    message:
                      'The analytical query exceeds the source-call budget. Ask the host to review the population scan, source-call and admission budgets.',
                  },
                ],
              }),
            );
            controller.signal.throwIfAborted();
          }

          sourceCalls++;
        },
      };
      const retire = () => controller.abort(new ReadError('runtime-retired'));

      analytics.signal.addEventListener('abort', retire, { once: true });

      if (analytics.signal.aborted) retire();

      const remaining =
        Math.min(request.timeoutMs ?? Infinity, limits.operationTimeoutMs) -
        (performance.now() - started);

      if (remaining <= 0) controller.abort(new ReadError('unavailable'));

      const timer = setTimeout(
        () => controller.abort(new ReadError('unavailable')),
        Math.max(0, remaining),
      );
      const materialize = createMaterializer(
        object,
        prepared.dependencies,
        controls.maxAgeMs!,
      );

      try {
        controller.signal.throwIfAborted();
        let page: FullPageResult;
        const readTimes = new Map<string, number>();

        if (kind === 'get') {
          const initial = await measure('candidates', () =>
            measure('dependencyReads', () =>
              options.read(
                attempt,
                principal,
                type,
                id!,
                controls,
                undefined,
                undefined,
                execution,
              ),
            ),
          );

          controller.signal.throwIfAborted();

          if (initial.status !== 'ok') return initial;

          readTimes.set(initial.id, options.clock());
          page = { data: [initial], meta: { exhausted: true } };
        } else {
          const context: QueryContext = {
            signal: controller.signal,
            execution,
            captureCandidate: (record, at) => {
              readTimes.set(record.id, at);
            },
            beginDependencyRead: () => beginTiming(timings, 'dependencyReads'),
            beginFinalization: () => beginTiming(timings, 'finalization'),
            candidateControls: { maxAgeMs: controls.maxAgeMs!, stale: 'allow' },
            cursorScope: {
              compute: computeSnapshot,
              select: request.select ?? null,
              requireComplete: request.requireComplete ?? false,
              bindings: bindingRevisions,
            },
          };

          page = await measure('candidates', () =>
            readQueryCandidates({
              scopeFirst,
              limits,
              controller,
              operation,
              context,
              query: (request, context) =>
                options.query(attempt, principal, type, request, context),
              request: {
                ...request,
                ...(request.select === undefined ? {} : { select: selection }),
                requireComplete: false,
                evidence: 'full',
                limit: limit ?? 25,
                ...(cursor === undefined ? {} : { cursor }),
                where,
              },
            }),
          );
        }

        controller.signal.throwIfAborted();
        const candidates = page.data.map((record) => {
          const at = readTimes.get(record.id) ?? options.clock();

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
          ...(summary ? { activity: summary } : {}),
          prepared,
          maxSlots: limits.maxKeysPerStatement,
          statementTimeoutMs: limits.statementTimeoutMs,
          maxConcurrentStatements: limits.maxConcurrentStatements,
          candidates,
          binding: analytics.binding,
          signal: controller.signal,
          clock: options.clock,
          ...(scopeFirst
            ? { requireComplete: request.requireComplete ?? false }
            : {}),
          ...(timings ? { timings } : {}),
        });

        const { revalidate, projectRecord } = createRecordFinalizer({
          object,
          selection,
          selectedOrdinary,
          controls,
          request,
          computed,
          required,
          scopeFirst,
          operation,
          signal: controller.signal,
          clock: options.clock,
          materialize,
          associations: () =>
            actorAssociations(options.manifest, principal, object),
          filter,
          ...(summary ? { summary } : {}),
          read: (id, capture) =>
            measure('dependencyReads', () =>
              options.read(
                attempt,
                principal,
                type,
                id,
                { ...controls, refresh: false, stale: 'allow' },
                undefined,
                capture,
                execution,
              ),
            ),
        });
        const validated = (
          await measure('revalidation', () =>
            mapReads(
              page.data,
              (record) => revalidate(record),
              controller.signal,
            ),
          )
        ).filter((row): row is Validated => row !== undefined);
        const data: FullObjectRecord[] = [];
        let meta = page.meta;

        if (scopeFirst) {
          const ranked = await measure('finalization', async () =>
            rankPage(validated, ordering, scopeCursor, position, limit ?? 25),
          );

          meta = ranked.meta;
          const chosen = ranked.chosen;

          const final = await measure('revalidation', () =>
            mapReads(
              chosen,
              (entry) => revalidate(entry.row.record, entry.row.fields),
              controller.signal,
            ),
          );

          await measure('finalization', async () => {
            for (const current of final)
              if (current) data.push(projectRecord(current));
          });
        } else {
          await measure('finalization', async () => {
            for (const row of validated) data.push(projectRecord(row));
          });
        }

        controller.signal.throwIfAborted();

        return kind === 'get'
          ? data[0]
            ? { status: 'ok', ...data[0] }
            : { status: 'not-found' }
          : { data, meta };
      } finally {
        if (timer !== undefined) clearTimeout(timer);

        analytics.signal.removeEventListener('abort', retire);
      }
    } catch (error) {
      if (error instanceof AnalyticalPreparationError)
        throw new ReadError('invalid-request', {
          operation: operationName(options.manifest, principal, type, kind),
          issues: error.issues.map((issue) => ({
            ...issue,
            path: issue.path ?? ['compute'],
          })),
        });

      if (error instanceof AnalyticalIncompleteError)
        throw new ReadError('incomplete', {
          operation: operationName(options.manifest, principal, type, kind),
          issues: Object.entries(error.fields).map(([name, field]) => ({
            path: [name],
            problem: 'invalid-value',
            message:
              field.status === 'unavailable' ? field.reason : field.status,
          })),
        });

      throw error;
    } finally {
      endPreparation();
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
