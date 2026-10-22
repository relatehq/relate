import { ReadError } from '@relate/protocol';
import type {
  ReadRequest,
  QueryRequest,
  FullPageResult,
  FullObjectRecord,
  FullObjectResult,
} from '@relate/protocol';
import type { Principal } from '../authorization/index.js';
import { actorAssociations, operationName } from '../authorization/index.js';
import type { OperationScope } from '../activity/index.js';
import {
  beginTiming,
  computeFields,
  AnalyticalPreparationError,
  resolveAnalyticalLimits,
  AnalyticalIncompleteError,
} from '../analytics/index.js';
import { mapReads, project } from '../reads/index.js';
import type { QueryContext } from '../queries/index.js';
import { readQueryCandidates, rankPage } from './query.js';
import { createMaterializer, createRecordFinalizer } from './record.js';
import type { RevalidatedRecord } from './record.js';
import { prepareAnalyticalRead } from './prepare.js';
import { createAnalyticalOperation } from './operation.js';
import type { AnalyticalReadDependencies } from './types.js';

/** Prepare, collect, compute, revalidate and project through authorized ordinary reads. */
export function createAnalyticalReads(options: AnalyticalReadDependencies) {
  const limits = resolveAnalyticalLimits(options.analytics?.limits);
  const run = async (
    kind: 'get' | 'query',
    attempt: OperationScope,
    principal: Principal,
    type: string,
    id: string | undefined,
    input: QueryRequest,
  ): Promise<FullObjectResult | FullPageResult> => {
    const started = performance.now();

    try {
      const plan = prepareAnalyticalRead(options, {
        kind,
        attempt,
        principal,
        objectType: type,
        request: input,
        limits,
      });

      if (plan.kind === 'ordinary')
        return kind === 'get'
          ? (
              await options.read({
                attempt,
                principal,
                objectType: type,
                id: id!,
                request: plan.request,
              })
            ).result
          : options.query({
              attempt,
              principal,
              objectType: type,
              request: plan.request,
            });

      if (plan.kind === 'not-found') return { status: 'not-found' };

      const {
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
        position,
        queryRequest,
        queryCursorScope,
        timings,
        summary,
      } = plan;
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
      const lifetime = createAnalyticalOperation({
        operation,
        limits,
        signal: analytics.signal,
        started,
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
      });
      const { controller, execution } = lifetime;
      const materialize = createMaterializer(
        object,
        prepared.dependencies,
        controls.maxAgeMs!,
      );

      try {
        controller.signal.throwIfAborted();
        let page: FullPageResult;
        const readTimes = new Map<string, number>();

        if (mode === 'get') {
          const { result: initial } = await measure('candidates', () =>
            measure('dependencyReads', () =>
              options.read({
                attempt,
                principal,
                objectType: type,
                id: id!,
                request: controls,
                execution,
              }),
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
            cursorScope: queryCursorScope,
          };

          page = await measure('candidates', () =>
            readQueryCandidates({
              mode,
              limits,
              controller,
              operation,
              context,
              query: (request, context) =>
                options.query({
                  attempt,
                  principal,
                  objectType: type,
                  request,
                  context,
                }),
              request: queryRequest,
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
          ...(mode === 'rank-scope'
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
          mode,
          operation,
          signal: controller.signal,
          clock: options.clock,
          materialize,
          associations: () =>
            actorAssociations(options.manifest, principal, object),
          filter,
          ...(summary ? { summary } : {}),
          read: (id) =>
            measure('dependencyReads', () =>
              options.read({
                attempt,
                principal,
                objectType: type,
                id,
                request: { ...controls, refresh: false, stale: 'allow' },
                execution,
              }),
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
        ).filter((row): row is RevalidatedRecord => row !== undefined);
        const data: FullObjectRecord[] = [];
        let meta = page.meta;

        if (mode === 'rank-scope') {
          const ranked = await measure('finalization', async () =>
            rankPage(
              validated,
              ordering,
              scopeCursor,
              position,
              queryRequest.limit ?? 25,
            ),
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
        lifetime.close();
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
