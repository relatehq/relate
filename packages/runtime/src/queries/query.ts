import { actionOverlay, adoptionStore } from '../actions/index.js';
import { selectedProperties, selectionIssues } from '../reads/index.js';
import { mapReads } from '../reads/index.js';
import type { ReadExecution } from '../reads/index.js';
import type { OperationScope } from '../activity/index.js';
import { randomUUID } from 'node:crypto';
import type { QueryCursors } from './cursors.js';
import type { Manifest } from 'relate/model';
import { ReadError } from '@relate/protocol';
import type {
  QueryRequest,
  ReadControls,
  ReadRequest,
  FullReadResult as ReadResult,
  FullPageResult as PageResult,
  FullObjectRecord as ObjectRecord,
} from '@relate/protocol';
import type {
  ObservationStore,
  StorageScope,
  StoredObject,
  NativeScope,
  NativeTransaction,
} from '../storage.js';
import { scanMembers } from '../storage.js';
import {
  allowsField,
  allowsObject,
  filterableProperties,
  operationName,
} from '../authorization/index.js';
import type { Principal } from '../authorization/index.js';
import {
  compileWhere,
  calculatedReadIssues,
  predicateMatcher,
  type Predicate,
  project,
  requestIssues,
  throwIssues,
} from '../reads/index.js';

type Available = Extract<ReadResult, { status: 'ok' }>;

/** Trusted composition controls; never accepted from a consumer request. */
export interface QueryContext {
  readonly execution?: ReadExecution;
  readonly scanCandidates?: (count: number) => void;
  readonly admitCandidate?: () => void;
  readonly captureCandidate?: (record: ObjectRecord, at: number) => void;
  readonly cursorScope?: unknown;
  readonly signal?: AbortSignal;
  readonly beginDependencyRead?: () => () => void;
  readonly beginFinalization?: () => () => void;
  readonly candidateControls?: Pick<ReadControls, 'maxAgeMs' | 'stale'>;
}

/** Enumerate graph membership through the same authorized read path as get. */
export function createGraphQuery(options: {
  manifest: Manifest;
  scope: NativeScope;
  store: ObservationStore;
  clock(): number;
  install(): Promise<void>;
  cursors: QueryCursors;
  scopeFor(type: string, source: string): StorageScope;
  read(
    attempt: OperationScope,
    principal: Principal,
    type: string,
    id: string,
    request: ReadRequest,
    requiredReference?: string,
    capture?: (check: () => Promise<boolean>) => void,
    transaction?: NativeTransaction,
    execution?: ReadExecution,
    snapshot?: StoredObject,
  ): Promise<ReadResult>;
}) {
  const { manifest, store, clock } = options;
  const transactions = new WeakMap<NativeTransaction, string>();

  return async (
    attempt: OperationScope,
    principal: Principal,
    type: string,
    input: QueryRequest = {},
    transaction?: NativeTransaction,
    onRead?: (id: string, result: Available) => void,
    context?: QueryContext,
  ): Promise<PageResult> => {
    const object = manifest.objects.find((o) => o.id === type);
    const policy = object && manifest.policies[object.id];
    const operation = operationName(manifest, principal, type, 'query');
    const issues = requestIssues(
      input,
      'query',
      context?.execution?.expandedSelection,
    );
    const predicates: Predicate[] = [];

    context?.signal?.throwIfAborted();

    if (input?.compute !== undefined || input?.orderBy !== undefined)
      issues.push({
        path: [input.compute !== undefined ? 'compute' : 'orderBy'],
        problem: 'not-supported',
        message:
          'Analytical requests require the analytical query path and are not supported in action transactions.',
      });

    if (transaction && object && allowsObject(principal, policy)) {
      const calculated = calculatedReadIssues(
        input,
        (object.calculations ?? []).map((property) => ({
          name: property.name,
          defaultSelected: allowsField(principal, policy!, property.access),
        })),
      );

      if (calculated.length)
        throwIssues(operation, 'query', [...issues, ...calculated]);
    }

    if (!object)
      issues.push({
        path: [],
        problem: 'invalid-value',
        message: 'unknown object type.',
      });
    // Validate filters before consulting membership, including empty populations.
    // An unreadable type returns an empty page below, with or without filters,
    // so its property names are neither checked nor offered.
    else if (input?.where !== undefined && allowsObject(principal, policy))
      predicates.push(
        ...compileWhere(
          object.apiName,
          () => filterableProperties(manifest, principal, object),
          input.where,
          issues,
        ),
      );

    if (!object || issues.length) throwIssues(operation, 'query', issues);

    const limit = input.limit ?? 25;

    const request: QueryRequest = structuredClone(
      Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      ),
    );
    // Evidence mode is presentation only, so it stays out of the cursor scope.
    const {
      cursor,
      limit: _limit,
      evidence: _evidence,
      where: filters = {},
      ...readRequest
    } = request;
    const filterNames = Object.keys(filters);
    const selected = selectedProperties(
      object.properties,
      readRequest.select,
      (p) => Boolean(policy && allowsField(principal, policy, p.access)),
    );
    const needed = [...new Set([...selected, ...filterNames])];

    const selectedIssues = selectionIssues(
      readRequest.select,
      needed,
      context?.execution?.expandedSelection,
    );

    if (selectedIssues.length) throwIssues(operation, 'query', selectedIssues);

    if (transaction && !transactions.has(transaction))
      transactions.set(transaction, randomUUID());

    const cursorScope = options.cursors(
      type,
      principal,
      { ...readRequest, where: predicates, limit },
      context?.cursorScope,
      transaction ? transactions.get(transaction)! : undefined,
    );
    let after = cursor ? cursorScope.decode(cursor, operation) : undefined;

    if (!allowsObject(principal, policy))
      return { data: [], meta: { exhausted: true } };

    await options.install();

    if (!object.sourceDefinitionId && !store.native)
      throw new ReadError('unavailable');

    const filter = predicateMatcher(predicates, readRequest, clock);
    const readCandidate = async (id: string, snapshot?: StoredObject) => {
      context?.signal?.throwIfAborted();
      let allowed = async () => false;
      const endRead = context?.beginDependencyRead?.();
      let result;

      try {
        result = await options.read(
          attempt,
          principal,
          type,
          id,
          {
            ...readRequest,
            ...context?.candidateControls,
            ...(readRequest.select ? { select: needed } : {}),
            requireComplete: false,
          },
          undefined,
          (check) => {
            allowed = check;
          },
          transaction,
          context?.execution,
          snapshot,
        );
      } finally {
        endRead?.();
      }

      context?.signal?.throwIfAborted();

      return { result, allowed: () => allowed() };
    };
    const pending: {
      id: string;
      result: Available;
      at: number;
      allowed(): Promise<boolean>;
    }[] = [];
    let scanned = 0;
    let more = true;

    // TODO(performance): Use indexed native candidates for selective predicates;
    // bounded scans still require traversing the population across pages.
    // For source-backed objects, retain cached non-matches that require refresh:
    // they may become matches. Keep authorized reads and final predicate checks.
    while (more && scanned < 100 && pending.length < limit) {
      context?.signal?.throwIfAborted();
      const take = Math.min(100 - scanned, limit - pending.length);
      const source = object.sourceDefinitionId;
      // Candidate reads start from source scan snapshots.
      const batch = await scanMembers(
        source
          ? (scan) =>
              adoptionStore(store, actionOverlay(transaction)).scan(
                options.scopeFor(type, source),
                scan,
              )
          : undefined,
        (scan) =>
          transaction
            ? transaction.scan(type, scan)
            : store.native!.scan(options.scope, type, scan),
        after,
        take,
      );

      more = batch.hasMore;

      if (!batch.ids.length) break;

      after = batch.ids.at(-1);
      scanned += batch.ids.length;
      context?.scanCandidates?.(batch.ids.length);

      // Transactions share one connection; independent reads can overlap. Each
      // candidate is evaluated as soon as its read settles, while evidence is fresh.
      const evaluate = async ({
        id,
        snapshot,
      }: {
        id: string;
        snapshot: StoredObject | undefined;
      }) => {
        const { result, allowed } = await readCandidate(id, snapshot);

        if (result.status !== 'ok') return undefined;

        const at = clock();

        return {
          id,
          result,
          at,
          allowed,
          match: filter.matches(id, result, at),
        };
      };
      const evaluated = await mapReads(
        batch.ids.map((id, index) => ({
          id,
          snapshot: batch.snapshots?.[index],
        })),
        evaluate,
        context?.signal,
        transaction ? 1 : 8,
      );

      for (const item of evaluated) {
        if (!item) continue;

        onRead?.(item.id, item.result);

        if (item.match) pending.push(item);
      }
    }

    const endFinalization = context?.beginFinalization?.();

    try {
      const data: ObjectRecord[] = [];

      for (const item of pending) {
        context?.signal?.throwIfAborted();

        if (!(await item.allowed())) continue;

        const at = await filter.confirm(item, async () => {
          const reread = await readCandidate(item.id);

          if (reread.result.status !== 'ok' || !(await reread.allowed()))
            return undefined;

          onRead?.(item.id, reread.result);
          item.at = clock();

          return reread.result;
        });

        if (at !== undefined) {
          context?.admitCandidate?.();
          const readAt = context?.captureCandidate ? item.at : at;
          const record = project(
            item.id,
            item.result,
            selected,
            readRequest,
            readAt,
          );

          context?.captureCandidate?.(record, readAt);
          data.push(record);
        }
      }

      context?.signal?.throwIfAborted();

      return {
        data,
        meta: more
          ? {
              exhausted: false,
              continuationCursor: cursorScope.encode(after!, operation),
            }
          : { exhausted: true },
      };
    } finally {
      endFinalization?.();
    }
  };
}
