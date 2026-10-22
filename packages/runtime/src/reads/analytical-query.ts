import { ReadError } from '@relate/protocol';
import type {
  QueryRequest,
  FullPageResult,
  FullObjectRecord,
} from '@relate/protocol';
import type { AnalyticalLimits } from 'relate/analytics';
import type { QueryContext, QueryCursors } from '../queries/index.js';
import type {
  prepareComputedOrder,
  ComputedPosition,
} from '../analytics/index.js';
import type { Validated } from './analytical-record.js';

/** Page-first enrichment and full-scope ranking share authorized ordinary reads. */
export async function readQueryCandidates(options: {
  scopeFirst: boolean;
  limits: Required<AnalyticalLimits>;
  controller: AbortController;
  operation: string;
  context: QueryContext;
  request: QueryRequest;
  query(request: QueryRequest, context: QueryContext): Promise<FullPageResult>;
}): Promise<FullPageResult> {
  const { scopeFirst, limits, controller, operation, query, request } = options;
  let scanned = 0,
    admitted = 0;
  const exceeded = (budget: string): never => {
    const error = new ReadError('resource-exhausted', {
      operation,
      issues: [
        {
          path: [],
          problem: 'limit-exceeded',
          message: `The analytical query exceeds the ${budget} budget. Ask the host to review the population scan, source-call and admission budgets.`,
        },
      ],
    });

    controller.abort(error);
    throw error;
  };
  const context: QueryContext = {
    ...options.context,
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
  const { cursor, ...ordinary } = request;
  const readPage = (next?: string) =>
    query(
      {
        ...ordinary,
        limit: scopeFirst ? 100 : (request.limit ?? 25),
        ...(next === undefined ? {} : { cursor: next }),
      },
      context,
    );

  return scopeFirst
    ? readMatchingScope(readPage, controller.signal)
    : readPage(cursor);
}

/** Full-scope ranking reads every ordinary page before analytical execution. */
async function readMatchingScope(
  readPage: (cursor?: string) => Promise<FullPageResult>,
  signal: AbortSignal,
): Promise<FullPageResult> {
  const data: FullObjectRecord[] = [];
  let cursor: string | undefined;

  do {
    signal.throwIfAborted();
    const batch = await readPage(cursor);

    data.push(...batch.data);

    if (batch.meta.exhausted) break;

    cursor = batch.meta.continuationCursor;
  } while (cursor);

  return { data, meta: { exhausted: true } };
}

/** Select one page only after all authorized matches have been computed and revalidated. */
export function rankPage(
  rows: readonly Validated[],
  ordering: ReturnType<typeof prepareComputedOrder>,
  cursor: ReturnType<QueryCursors>,
  position: ComputedPosition | undefined,
  limit: number,
) {
  const eligible = rows
    .filter((row) => ordering.matches(row.fields))
    .map((row) => ({
      row,
      position: ordering.position(row.record.id, row.fields),
    }))
    .sort((a, b) => ordering.compare(a.position, b.position))
    .filter(
      (entry) => !position || ordering.compare(entry.position, position) > 0,
    );
  const chosen = eligible.slice(0, limit);
  const meta: FullPageResult['meta'] =
    eligible.length > chosen.length
      ? {
          exhausted: false,
          continuationCursor: cursor.encode(
            JSON.stringify(chosen.at(-1)!.position),
          ),
        }
      : { exhausted: true };

  return { chosen, meta };
}
