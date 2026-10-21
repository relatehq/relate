import type { QueryContext, QueryCursors } from './queries/index.js';
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
import type { SqlParser, AnalyticalLimits } from 'relate/analytics';
import type { ReadExecution } from './reads/index.js';
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
import { operationDiagnostics } from './activity/index.js';
import {
  createAnalyticalTimings,
  createCalculationSummary,
  captureCalculations,
  beginTiming,
  prepareCompute,
  preparedBindingRevisions,
  computeFields,
  revalidateFields,
  AnalyticalPreparationError,
  resolveAnalyticalLimits,
  prepareComputedOrder,
  AnalyticalIncompleteError,
} from './analytics/index.js';
import type {
  AnalyticalBinding,
  AuthorizedCandidate,
  ComputedField,
  ComputedPosition,
} from './analytics/index.js';
import {
  project,
  requestIssues,
  rejectIssues,
  summarize,
  compileWhere,
  predicateMatcher,
  cursorIssue,
} from './reads/index.js';

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
      input?.select ??
      (object
        ? [...object.properties, ...(object.calculations ?? [])]
            .filter(
              (property) =>
                policy && allowsField(principal, policy, property.access),
            )
            .map((property) => property.name)
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
      input.orderBy === undefined
    )
      return kind === 'get'
        ? options.read(attempt, principal, type, id!, input)
        : options.query(attempt, principal, type, input);

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

      if (
        request.select &&
        new Set([...selectedOrdinary, ...filter.names]).size > 100
      )
        rejectIssues(operation, kind, [
          {
            path: ['select'],
            problem: 'invalid-value',
            message: 'select and where together name more than 100 properties.',
          },
        ]);

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
              new ReadError('invalid-request', {
                operation,
                issues: [
                  {
                    path: [],
                    problem: 'not-supported',
                    message:
                      'The analytical query exceeds the source-call budget. Use a narrower ordinary property filter or ask the host to raise the budget.',
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

          page = { data: [initial], meta: { exhausted: true } };
        } else {
          let scanned = 0,
            admitted = 0;
          const exceeded = (budget: string): never => {
            const error = new ReadError('invalid-request', {
              operation,
              issues: [
                {
                  path: [],
                  problem: 'not-supported',
                  message: `The analytical query exceeds the ${budget} budget. Use a narrower ordinary property filter or ask the host to raise the budget.`,
                },
              ],
            });

            controller.abort(error);
            throw error;
          };
          const context: QueryContext = {
            signal: controller.signal,
            execution,
            beginDependencyRead: () => beginTiming(timings, 'dependencyReads'),
            beginFinalization: () => beginTiming(timings, 'finalization'),
            candidateControls: { maxAgeMs: controls.maxAgeMs!, stale: 'allow' },
            cursorScope: {
              compute: computeSnapshot,
              select: request.select ?? null,
              requireComplete: request.requireComplete ?? false,
              bindings: bindingRevisions,
            },
            ...(scopeFirst
              ? {
                  scanCandidates(count: number) {
                    scanned += count;

                    if (scanned > limits.maxCandidatesScanned)
                      exceeded('candidate scan');
                  },
                  admitCandidate() {
                    if (++admitted > limits.maxCandidatesAdmitted)
                      exceeded('admitted candidate');
                  },
                }
              : {}),
          };
          const readPage = (next?: string) =>
            options.query(
              attempt,
              principal,
              type,
              {
                ...request,
                ...(request.select === undefined ? {} : { select: selection }),
                requireComplete: false,
                evidence: 'full',
                limit: scopeFirst ? 100 : (limit ?? 25),
                ...(next === undefined ? {} : { cursor: next }),
                where,
              },
              context,
            );

          page = await measure('candidates', async () => {
            if (!scopeFirst) return readPage(cursor);

            const data: FullObjectRecord[] = [];
            let next: string | undefined;

            do {
              controller.signal.throwIfAborted();
              const batch = await readPage(next);

              data.push(...batch.data);

              if (batch.meta.exhausted) break;

              next = batch.meta.continuationCursor;
            } while (next);

            return { data, meta: { exhausted: true } };
          });
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

        type Validated = {
          record: FullObjectRecord;
          fields: Readonly<Record<string, ComputedField>>;
          at: number;
        };

        const revalidate = async (
          record: FullObjectRecord,
          previous = computed.rows.get(record.id)!,
        ): Promise<Validated | undefined> => {
          controller.signal.throwIfAborted();
          let allowed = async () => false;
          const current = await measure('dependencyReads', () =>
            options.read(
              attempt,
              principal,
              type,
              record.id,
              { ...controls, refresh: false, stale: 'allow' },
              undefined,
              (check) => {
                allowed = check;
              },
              execution,
            ),
          );

          controller.signal.throwIfAborted();

          if (current.status !== 'ok') return undefined;

          const visible = await allowed();

          controller.signal.throwIfAborted();

          if (!visible) return undefined;

          const at = options.clock();
          const fresh = project(record.id, current, selection, controls, at);
          const fields = revalidateFields(
            previous,
            materialize(fresh, at),
            actorAssociations(options.manifest, principal, object),
          );

          captureCalculations(summary, (capture) =>
            capture.results(fields, previous),
          );
          const failures = Object.fromEntries(
            [
              ...new Set([
                ...required,
                ...(scopeFirst && request.requireComplete
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

          if (!filter.matches(record.id, current, at)) return undefined;

          return { record: current, fields, at };
        };
        const projectRecord = ({
          record,
          fields,
          at,
        }: Validated): FullObjectRecord => {
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

          return output;
        };
        const validated = await measure('revalidation', async () => {
          const rows: Validated[] = [];

          for (const record of page.data) {
            const row = await revalidate(record);

            if (row) rows.push(row);
          }

          return rows;
        });
        const data: FullObjectRecord[] = [];
        let meta = page.meta;

        if (scopeFirst) {
          const chosen = await measure('finalization', async () => {
            const eligible = validated
              .filter((row) => ordering.matches(row.fields))
              .map((row) => ({
                row,
                position: ordering.position(row.record.id, row.fields),
              }))
              .sort((a, b) => ordering.compare(a.position, b.position))
              .filter(
                (entry) =>
                  !position || ordering.compare(entry.position, position) > 0,
              );
            const selected = eligible.slice(0, limit ?? 25);

            meta =
              eligible.length > selected.length
                ? {
                    exhausted: false,
                    continuationCursor: scopeCursor.encode(
                      JSON.stringify(selected.at(-1)!.position),
                    ),
                  }
                : { exhausted: true };

            return selected;
          });

          await measure('revalidation', async () => {
            for (const entry of chosen) {
              const current = await revalidate(
                entry.row.record,
                entry.row.fields,
              );

              if (current)
                data.push(
                  await measure('finalization', async () =>
                    projectRecord(current),
                  ),
                );
            }
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
