/**
 * What the Activity screen shows, derived from the grouped activity events:
 * requests with their timing, a small query language, facets, the histogram,
 * the operation waterfall, the objects a request touched and its metadata.
 * Pure functions over protocol events, so the screen only renders.
 */
import type { RequestActivity } from '../connection/activity.js';
import type { ActivityStatus, OperationEvent } from '../protocol.js';

/** Where a request came from: the call's source, or its transport without a call. */
export type RequestSource =
  'agent' | 'playground' | 'external' | 'embedded' | 'http' | 'mcp';

export interface ActivityRequest extends RequestActivity {
  /** Epoch milliseconds of the earliest event. */
  readonly start: number;
  /** Elapsed time: the call's, else the execution's, else the operations' span. */
  readonly ms: number | undefined;
  readonly status: ActivityStatus;
  readonly principal: string | null;
  readonly source: RequestSource;
  /** `execute`, `discover`, or the transport for a request without a call. */
  readonly tool: string;
  readonly runtimeId: string | null;
}

const time = (at: string) => new Date(at).getTime();

export const isAction = (operation: OperationEvent) =>
  operation.op === 'invoke' ||
  operation.op === 'getReceipt' ||
  operation.op === 'invocation-succeeded' ||
  operation.op === 'invocation-failed';

export const isCommitted = (operation: OperationEvent) =>
  operation.runtime?.record === 'committed';

export function describeRequest(request: RequestActivity): ActivityRequest {
  const { call, execution, operations } = request;
  const starts = [
    call?.at,
    execution?.at,
    ...operations.map((operation) => operation.at),
  ]
    .filter((at): at is string => at !== undefined)
    .map(time);
  const start = starts.length ? Math.min(...starts) : 0;
  const ends = operations
    .filter((operation) => operation.ms !== undefined)
    .map((operation) => time(operation.at) + operation.ms!);
  const status =
    call?.status ??
    execution?.status ??
    (operations.some((operation) => operation.status === 'running')
      ? 'running'
      : operations.some((operation) => operation.status === 'failed')
        ? 'failed'
        : 'succeeded');
  const transport = operations[0]?.context.transport;

  return {
    ...request,
    start,
    ms:
      call?.ms ??
      execution?.ms ??
      (status !== 'running' && ends.length
        ? Math.max(...ends) - start
        : undefined),
    status,
    principal: call?.principal ?? operations[0]?.context.principal ?? null,
    source:
      call?.source === 'inspector-agent'
        ? 'agent'
        : call?.source === 'inspector-playground'
          ? 'playground'
          : call
            ? 'external'
            : (transport ?? 'external'),
    tool: call?.tool ?? transport ?? 'request',
    runtimeId:
      call?.runtimeId ??
      execution?.runtimeId ??
      operations[0]?.context.runtimeId ??
      null,
  };
}

/** One row of the operation waterfall, in start order with its nesting depth. */
export interface TimelineEntry {
  readonly operation: OperationEvent;
  readonly depth: number;
  /** Milliseconds from the request's start. */
  readonly offset: number;
}

/**
 * Operations in start order, each nested under the operation that triggered
 * it (`runtime.parentOperationId`) when that operation is in the request.
 */
export function timeline(request: ActivityRequest): readonly TimelineEntry[] {
  const byId = new Map(
    request.operations.map((operation) => [operation.opId, operation]),
  );
  const depthOf = (operation: OperationEvent, seen = new Set<string>()) => {
    let depth = 0;
    let parent = operation.runtime?.parentOperationId;

    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = byId.get(parent)!.runtime?.parentOperationId;
    }

    return depth;
  };
  const children = new Map<string | undefined, OperationEvent[]>();

  for (const operation of [...request.operations].sort(
    (a, b) => time(a.at) - time(b.at),
  )) {
    const parent = operation.runtime?.parentOperationId;
    const key = parent && byId.has(parent) ? parent : undefined;

    children.set(key, [...(children.get(key) ?? []), operation]);
  }

  const entries: TimelineEntry[] = [];
  const visit = (parent: string | undefined) => {
    for (const operation of children.get(parent) ?? []) {
      entries.push({
        operation,
        depth: depthOf(operation),
        offset: Math.max(0, time(operation.at) - request.start),
      });
      visit(operation.opId);
    }
  };

  visit(undefined);

  // A parent cycle leaves operations unvisited; list them flat rather than drop them.
  for (const operation of request.operations)
    if (!entries.some((entry) => entry.operation === operation))
      entries.push({
        operation,
        depth: 0,
        offset: Math.max(0, time(operation.at) - request.start),
      });

  return entries;
}

/** The span the waterfall is drawn against: elapsed time or the last operation's end. */
export function timelineSpan(
  request: ActivityRequest,
  entries: readonly TimelineEntry[],
  now: number,
): number {
  const running = request.status === 'running' ? now - request.start : 0;

  return Math.max(
    1,
    request.ms ?? 0,
    running,
    ...entries.map(
      (entry) =>
        entry.offset +
        (entry.operation.ms ?? (running ? running - entry.offset : 0)),
    ),
  );
}

// Query language ----------------------------------------------------------

export const queryKeys = [
  'principal',
  'source',
  'transport',
  'tool',
  'op',
  'def',
  'status',
  'runtime',
  'record',
  'object',
  'req',
  'analytical',
  'duration',
] as const;

export type QueryKey = (typeof queryKeys)[number];

const aliases: Record<string, QueryKey> = {
  who: 'principal',
  definition: 'def',
  id: 'object',
  request: 'req',
  ms: 'duration',
};

export interface QueryToken {
  readonly raw: string;
  readonly negated: boolean;
  /** `text` matches anywhere in the request or event. */
  readonly key: QueryKey | 'text';
  readonly comparator: ':' | '>' | '<' | '>=' | '<=' | '=';
  /** Any of these, compared case-insensitively by substring. */
  readonly values: readonly string[];
}

/**
 * `principal:ops@acme.com status:failed duration>100ms -source:agent def:customer,invoice`.
 * Unknown keys and bare words search the text of the event.
 */
export function parseQuery(query: string): readonly QueryToken[] {
  return (
    query.match(/-?[\w.]+(?::|>=|<=|>|<|=)"[^"]*"|"[^"]*"|\S+/g) ?? []
  ).flatMap((raw): QueryToken[] => {
    const match = raw.match(/^(-?)([\w.]+)(:|>=|<=|>|<|=)(.*)$/);
    const name = match?.[2]?.toLowerCase();
    const key =
      name === undefined
        ? undefined
        : (queryKeys as readonly string[]).includes(name)
          ? (name as QueryKey)
          : aliases[name];

    if (match && key) {
      const values = match[4]!.replace(/"/g, '').split(',').filter(Boolean);

      return values.length
        ? [
            {
              raw,
              negated: match[1] === '-',
              key,
              comparator: match[3] as QueryToken['comparator'],
              values,
            },
          ]
        : [];
    }

    const negated = raw.startsWith('-') && raw.length > 1;
    const value = (negated ? raw.slice(1) : raw).replace(/"/g, '');

    return value
      ? [{ raw, negated, key: 'text', comparator: ':', values: [value] }]
      : [];
  });
}

/** `250`, `250ms`, `1.5s`, `2m` in milliseconds. */
export function parseDuration(value: string): number | undefined {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/i);

  if (!match) return undefined;

  const unit = match[2]?.toLowerCase();

  return Number(match[1]) * (unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 1);
}

/** The searchable values of a request or one event; `ms` is compared numerically. */
export type Facts = Partial<
  Record<Exclude<QueryKey, 'duration'>, readonly string[]>
> & {
  readonly ms?: number | undefined;
  readonly text: string;
};

export function matches(tokens: readonly QueryToken[], facts: Facts): boolean {
  return tokens.every((token) => {
    let hit: boolean;

    if (token.key === 'duration') {
      const limit = parseDuration(token.values[0]!);
      const ms = facts.ms;

      hit =
        limit !== undefined &&
        ms !== undefined &&
        (token.comparator === '>'
          ? ms > limit
          : token.comparator === '<'
            ? ms < limit
            : token.comparator === '<='
              ? ms <= limit
              : token.comparator === '='
                ? Math.round(ms) === limit
                : ms >= limit);
    } else {
      const haystack =
        token.key === 'text' ? [facts.text] : (facts[token.key] ?? []);
      const lower = haystack.map((value) => value.toLowerCase());

      hit = token.values.some((value) =>
        lower.some((candidate) => candidate.includes(value.toLowerCase())),
      );
    }

    return token.negated ? !hit : hit;
  });
}

const definitionValues = (
  operation: OperationEvent,
  labels: ReadonlyMap<string, string>,
) => [operation.definitionId, labels.get(operation.definitionId) ?? ''];

export function operationFacts(
  request: ActivityRequest,
  operation: OperationEvent,
  labels: ReadonlyMap<string, string>,
): Facts {
  return {
    principal: [
      operation.context.principal,
      ...(operation.runtime ? [operation.runtime.actor.id] : []),
    ],
    source: [request.source],
    transport: [operation.context.transport],
    tool: [request.tool],
    op: [operation.op],
    def: definitionValues(operation, labels),
    status: [operation.status],
    runtime: [operation.context.runtimeId ?? ''],
    record: [operation.runtime?.record ?? 'dispatch'],
    object: [...operation.recordIds, operation.request.objectId ?? ''],
    req: [request.requestId],
    analytical: [operation.runtime?.analytical ? 'true' : 'false'],
    ms: operation.ms,
    text: [
      operation.op,
      ...definitionValues(operation, labels),
      requestSummary(operation, labels),
      outcomeSummary(operation),
    ].join(' '),
  };
}

export function requestFacts(
  request: ActivityRequest,
  labels: ReadonlyMap<string, string>,
): Facts {
  const operations = request.operations.map((operation) =>
    operationFacts(request, operation, labels),
  );
  const all = (key: Exclude<QueryKey, 'duration'>) =>
    operations.flatMap((facts) => facts[key] ?? []);

  return {
    principal: [request.principal ?? '', ...all('principal')],
    source: [request.source],
    transport: all('transport'),
    tool: [request.tool],
    op: [request.tool, ...all('op')],
    def: all('def'),
    status: [request.status, ...all('status')],
    runtime: [request.runtimeId ?? ''],
    record: all('record'),
    object: all('object'),
    req: [request.requestId],
    analytical: [
      request.operations.some((operation) => operation.runtime?.analytical)
        ? 'true'
        : 'false',
    ],
    ms: request.ms,
    text: [
      request.principal,
      request.tool,
      request.call?.error,
      request.execution?.code,
      request.execution?.resultPreview,
      request.execution?.error?.message,
      ...operations.map((facts) => facts.text),
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** Add a token unless the query already has it. */
export function addToken(query: string, token: string): string {
  return query.split(/\s+/).includes(token)
    ? query
    : `${query.trim()} ${token}`.trim();
}

export function removeToken(query: string, token: string): string {
  return query
    .split(/\s+/)
    .filter((part) => part !== token)
    .join(' ');
}

/** Quote a facet value that would otherwise split or end the token. */
export function facetToken(key: QueryKey, value: string): string {
  return /[\s,"]/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
}

// Facets and histogram ----------------------------------------------------

export interface FacetValue {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

/** The most frequent values of one fact across the visible items. */
export function facet<T>(
  items: readonly T[],
  valuesOf: (item: T) => readonly string[],
  labelOf: (value: string) => string = (value) => value,
  limit = 8,
): readonly FacetValue[] {
  const counts = new Map<string, number>();

  for (const item of items)
    for (const value of new Set(valuesOf(item)))
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);

  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, label: labelOf(value), count }));
}

export interface Bucket {
  readonly from: number;
  readonly ok: number;
  readonly failed: number;
}

export function histogram(
  items: readonly { readonly at: number; readonly failed: boolean }[],
  from: number,
  to: number,
  count = 40,
): readonly Bucket[] {
  const width = Math.max(1, to - from) / count;
  const buckets = Array.from({ length: count }, (_, index) => ({
    from: from + index * width,
    ok: 0,
    failed: 0,
  }));

  for (const item of items) {
    if (item.at < from || item.at > to) continue;

    const bucket =
      buckets[Math.min(count - 1, Math.floor((item.at - from) / width))]!;

    if (item.failed) bucket.failed += 1;
    else bucket.ok += 1;
  }

  return buckets;
}

// Summaries ---------------------------------------------------------------

export const shortId = (id: string) => id.slice(0, 8);

export const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '—';

  if (ms < 1) return `${ms.toFixed(2)} ms`;

  if (ms < 10) return `${ms.toFixed(1)} ms`;

  if (ms < 1_000) return `${Math.round(ms)} ms`;

  return `${(ms / 1_000).toFixed(2)} s`;
}

/** `where`, selection and paging in one line; values are previews already. */
export function requestSummary(
  operation: OperationEvent,
  labels: ReadonlyMap<string, string>,
): string {
  const { request, runtime } = operation;

  return [
    runtime?.record === 'committed' && runtime.position !== undefined
      ? `committed #${runtime.position}`
      : null,
    runtime?.changedPropertyIds?.length
      ? runtime.changedPropertyIds.map((id) => labels.get(id) ?? id).join(', ')
      : null,
    runtime?.actor.kind === 'source' ? `from ${runtime.actor.id}` : null,
    runtime?.triggeredBy ? `triggered by ${runtime.triggeredBy.id}` : null,
    request.objectId !== undefined ? `id ${request.objectId}` : null,
    request.traversal !== undefined ? `→ ${request.traversal}` : null,
    request.where !== undefined ? `where ${request.where}` : null,
    request.select !== undefined ? `select ${request.select.join(', ')}` : null,
    request.limit !== undefined ? `limit ${request.limit}` : null,
    request.cursor !== undefined ? 'next page' : null,
    request.input !== undefined ? `input ${request.input}` : null,
    request.idempotencyKey !== undefined
      ? `key ${request.idempotencyKey}`
      : null,
    request.invocationId !== undefined
      ? `invocation ${request.invocationId}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** What only the runtime knows: replay, refresh result, refused fields. */
function runtimeSummary(operation: OperationEvent): string[] {
  const runtime = operation.runtime;

  if (!runtime) return [];

  return [
    runtime.replayed ? 'replayed' : null,
    runtime.refresh ?? null,
    runtime.forbidden?.length
      ? `${plural(runtime.forbidden.length, 'field')} refused`
      : null,
    runtime.omittedObjects
      ? `${runtime.omittedObjects} more objects not recorded`
      : null,
  ].filter((part): part is string => part !== null);
}

export function outcomeSummary(operation: OperationEvent): string {
  const outcome = operation.outcome;

  if (!outcome)
    return operation.status === 'running'
      ? 'running…'
      : runtimeSummary(operation).join(' · ');

  if (outcome.error)
    return [
      outcome.error.code,
      outcome.error.message,
      outcome.error.issues,
      ...runtimeSummary(operation),
    ]
      .filter(Boolean)
      .join(' · ');

  return [
    outcome.found === true
      ? 'found'
      : outcome.found === false
        ? 'not found'
        : null,
    outcome.records !== undefined
      ? `${plural(outcome.records, 'record')}${outcome.hasMore ? ', more' : ''}`
      : null,
    outcome.receiptState !== undefined
      ? `receipt ${outcome.receiptState}`
      : null,
    outcome.evidenceWarnings
      ? plural(outcome.evidenceWarnings, 'evidence warning')
      : null,
    ...runtimeSummary(operation),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** The request's result line: its error, its returned preview, or its operation count. */
export function requestOutcome(request: ActivityRequest): string {
  const { call, execution } = request;

  if (request.status === 'running') return 'running…';

  if (execution?.error)
    return `${execution.error.code ?? execution.error.name}: ${execution.error.message}`;

  if (call?.error) return call.error;

  if (execution?.resultPreview !== undefined)
    return `returned ${execution.resultPreview}`;

  return request.operations.length
    ? plural(request.operations.length, 'operation')
    : '';
}

// Touched objects ---------------------------------------------------------

export interface TouchedRecord {
  readonly id: string;
  /** The operations that returned or changed it, in first-seen order. */
  readonly ops: readonly string[];
  /** Property IDs a committed change named. */
  readonly changed: readonly string[];
}

export interface TouchedDefinition {
  readonly definitionId: string;
  readonly action: boolean;
  readonly operations: number;
  readonly records: readonly TouchedRecord[];
  /** Committed changes: created, updated, deleted, restored, adopted. */
  readonly changes: number;
  /** Property IDs refused to the actor. */
  readonly forbidden: readonly string[];
  /** Objects the runtime did not record (`omittedObjects`). */
  readonly omitted: number;
  /** Operations whose record IDs reached the per-operation limit. */
  readonly capped: boolean;
}

/** Definitions in first-touch order, with each record the request returned or changed. */
export function touchedObjects(
  operations: readonly OperationEvent[],
  recordIdLimit: number,
): readonly TouchedDefinition[] {
  const definitions = new Map<
    string,
    {
      action: boolean;
      operations: number;
      records: Map<string, { ops: string[]; changed: Set<string> }>;
      changes: number;
      forbidden: Set<string>;
      omitted: number;
      capped: boolean;
    }
  >();

  for (const operation of operations) {
    let entry = definitions.get(operation.definitionId);

    if (!entry) {
      entry = {
        action: isAction(operation),
        operations: 0,
        records: new Map(),
        changes: 0,
        forbidden: new Set(),
        omitted: 0,
        capped: false,
      };
      definitions.set(operation.definitionId, entry);
    }

    entry.operations += 1;

    if (isCommitted(operation) && !isAction(operation)) entry.changes += 1;

    entry.omitted += operation.runtime?.omittedObjects ?? 0;
    entry.capped ||= operation.recordIds.length >= recordIdLimit;

    for (const id of operation.runtime?.forbidden ?? [])
      entry.forbidden.add(id);

    for (const id of operation.recordIds) {
      let record = entry.records.get(id);

      if (!record) {
        record = { ops: [], changed: new Set() };
        entry.records.set(id, record);
      }

      if (!record.ops.includes(operation.op)) record.ops.push(operation.op);

      for (const property of operation.runtime?.changedPropertyIds ?? [])
        record.changed.add(property);
    }
  }

  return [...definitions].map(([definitionId, entry]) => ({
    definitionId,
    action: entry.action,
    operations: entry.operations,
    records: [...entry.records].map(([id, record]) => ({
      id,
      ops: record.ops,
      changed: [...record.changed],
    })),
    changes: entry.changes,
    forbidden: [...entry.forbidden],
    omitted: entry.omitted,
    capped: entry.capped,
  }));
}

// Metadata ----------------------------------------------------------------

/**
 * Every scalar field of an event as a dotted path, in schema order. Fields
 * shown on their own tab (code, logs, record IDs, analytical timings) are
 * left out; arrays of scalars are joined and fractions keep three decimals.
 */
export function flattenFields(
  value: unknown,
  omit: ReadonlySet<string> = new Set(),
  prefix = '',
): readonly (readonly [string, string])[] {
  if (value === null || value === undefined) return [];

  if (typeof value === 'number' && !Number.isInteger(value))
    return [[prefix, String(Number(value.toFixed(3)))]];

  if (typeof value !== 'object') return [[prefix, String(value)]];

  if (Array.isArray(value))
    return value.every((item) => typeof item !== 'object' || item === null)
      ? [[prefix, value.length ? value.join(', ') : '[]']]
      : value.flatMap((item, index) =>
          flattenFields(item, omit, `${prefix}[${index}]`),
        );

  return Object.entries(value).flatMap(([key, item]) => {
    const path = prefix ? `${prefix}.${key}` : key;

    return omit.has(path) ? [] : flattenFields(item, omit, path);
  });
}

export const executionOmitted: ReadonlySet<string> = new Set([
  'code',
  'logs',
  'resultPreview',
]);

export const operationOmitted: ReadonlySet<string> = new Set([
  'recordIds',
  'runtime.analytical',
]);
