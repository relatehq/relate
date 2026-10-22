import { ReadError } from '@relate/protocol';
import type { QueryRequest, ReadRequest, RequestIssue } from '@relate/protocol';
import type { Manifest } from 'relate/model';
import type { AnalyticalLimits } from 'relate/analytics';
import {
  selectedProperties,
  selectionIssues,
  requestIssues,
  rejectIssues,
  compileWhere,
  predicateMatcher,
  cursorIssue,
} from '../reads/index.js';
import {
  actorAssociations,
  analyticalDeclarations,
  allowsField,
  allowsObject,
  operationName,
  filterableProperties,
} from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import { operationDiagnostics } from '../activity/index.js';
import type { OperationScope } from '../activity/index.js';
import {
  createAnalyticalTimings,
  createCalculationSummary,
  beginTiming,
  prepareCompute,
  preparedBindingRevisions,
  validatePreparedCapacity,
  AnalyticalPreparationError,
  prepareComputedOrder,
} from '../analytics/index.js';
import type {
  PreparedCompute,
  ComputedPosition,
  TimingCapture,
  CalculationCapture,
} from '../analytics/index.js';
import type { QueryCursors } from '../queries/index.js';
import type {
  AnalyticalReadDependencies,
  AnalyticalReadMode,
  AnalyticalReadOptions,
} from './types.js';

/** Normalized private execution state; ordinary delegation never opens analytical resources. */
export interface PreparedAnalyticalRead {
  readonly kind: 'analytical';
  readonly mode: AnalyticalReadMode;
  readonly object: Manifest['objects'][number];
  readonly operation: string;
  readonly analytics: AnalyticalReadOptions;
  readonly prepared: PreparedCompute;
  readonly request: ReadRequest;
  readonly controls: ReadRequest;
  readonly selection: readonly string[];
  readonly selectedOrdinary: readonly string[];
  readonly required: readonly string[];
  readonly filter: ReturnType<typeof predicateMatcher>;
  readonly ordering: ReturnType<typeof prepareComputedOrder>;
  readonly scopeCursor: ReturnType<QueryCursors>;
  readonly position?: ComputedPosition;
  readonly queryRequest: QueryRequest;
  readonly queryCursorScope: unknown;
  readonly timings?: TimingCapture;
  readonly summary?: CalculationCapture;
}

type ReadPreparation =
  | PreparedAnalyticalRead
  | { readonly kind: 'ordinary'; readonly request: QueryRequest }
  | { readonly kind: 'not-found' };

/** Validate selection, policy, expressions and cursor scope before asynchronous reads. */
export function prepareAnalyticalRead(
  options: Pick<
    AnalyticalReadDependencies,
    'manifest' | 'cursors' | 'analytics' | 'clock'
  >,
  read: {
    readonly kind: 'get' | 'query';
    readonly attempt: OperationScope;
    readonly principal: Principal;
    readonly objectType: string;
    readonly request: QueryRequest;
    readonly limits: Required<AnalyticalLimits>;
  },
): ReadPreparation {
  const {
    kind,
    attempt,
    principal,
    objectType: type,
    request: input,
    limits,
  } = read;

  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { kind: 'ordinary', request: input };

  const object = options.manifest.objects.find((entry) => entry.id === type);
  const policy = options.manifest.policies[type];
  const selected =
    input.select ??
    (object
      ? selectedProperties(
          [...object.properties, ...(object.calculations ?? [])],
          undefined,
          (property) =>
            Boolean(policy && allowsField(principal, policy, property.access)),
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
    return {
      kind: 'ordinary',
      request:
        kind === 'get'
          ? input
          : Object.fromEntries(
              Object.entries(input).filter(([key]) => key !== 'orderBy'),
            ),
    };

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
        ? { kind: 'not-found' }
        : { kind: 'ordinary', request: ordinary };

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
    const mode: AnalyticalReadMode =
      kind === 'get'
        ? 'get'
        : required.length > 0 || (Array.isArray(orderBy) && orderBy.length > 0)
          ? 'rank-scope'
          : 'enrich-page';
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

    if (mode === 'rank-scope' && cursor !== undefined) {
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

    return {
      kind: 'analytical',
      mode,
      object,
      operation,
      analytics,
      prepared,
      request,
      controls,
      selection,
      selectedOrdinary,
      required,
      filter,
      ordering,
      scopeCursor,
      ...(position ? { position } : {}),
      queryRequest: {
        ...request,
        ...(request.select === undefined ? {} : { select: selection }),
        requireComplete: false,
        evidence: 'full',
        limit: limit ?? 25,
        ...(cursor === undefined ? {} : { cursor }),
        where,
      },
      queryCursorScope: {
        compute: computeSnapshot,
        select: request.select ?? null,
        requireComplete: request.requireComplete ?? false,
        bindings: bindingRevisions,
      },
      ...(timings ? { timings } : {}),
      ...(summary ? { summary } : {}),
    };
  } finally {
    endPreparation();
  }
}
