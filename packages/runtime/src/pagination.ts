import { ReadError } from '@relate/protocol';
import type { Page } from '@relate/protocol';

/** Await one page, or iterate records across all pages. */
export interface QueryResult<T>
  extends PromiseLike<Page<T>>, AsyncIterable<T> {}

/** Validate the envelope, not records: the page reader owns policy and evidence. */
function validatePage<T>(page: Page<T>, cursor: string | undefined): void {
  if (
    !page ||
    !Array.isArray(page.data) ||
    !page.meta ||
    typeof page.meta !== 'object'
  )
    throw new ReadError('incomplete');

  const meta = page.meta;

  if (meta.exhausted === true) {
    if ('continuationCursor' in meta) throw new ReadError('incomplete');
  } else if (
    meta.exhausted !== false ||
    typeof meta.continuationCursor !== 'string' ||
    meta.continuationCursor.length === 0 ||
    meta.continuationCursor === cursor
  )
    throw new ReadError('incomplete');
}

/**
 * Wrap an authorized page reader for queries or to-many traversals.
 *
 * The reader captures immutable query options and the caller/transaction context;
 * this helper supplies only the changing cursor. The reader must enforce actual
 * scan progress, cursor scope, ordering and operation budgets. Opaque token
 * inequality alone cannot prove progress or snapshot consistency.
 *
 * Execution is lazy. All awaits and iterators on this handle share the first
 * page request (including failure). Each iterator has its own continuation state
 * and fetches subsequent pages on demand. Reiteration can refetch later pages;
 * this is not a materialized snapshot. No page is prefetched, so break/throw
 * stops further requests. Records and their evidence pass through unchanged.
 *
 * Malformed continuations and cycles throw ReadError('incomplete') before that
 * page's records are exposed. Reader failures propagate to the caller. The helper
 * neither commits nor retries: action transaction ownership stays with its caller.
 */
export function createQuery<T>(
  readPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { readonly cursor?: string } = {},
): QueryResult<T> {
  const initialCursor = options.cursor;

  if (
    initialCursor !== undefined &&
    (typeof initialCursor !== 'string' || initialCursor.length === 0)
  )
    throw new ReadError('invalid-request');

  const fetchPage = async (cursor: string | undefined): Promise<Page<T>> => {
    const page = await readPage(cursor);

    validatePage(page, cursor);

    return page;
  };
  let firstPage: Promise<Page<T>> | undefined;
  const first = () => (firstPage ??= fetchPage(initialCursor));

  return {
    then(onfulfilled, onrejected) {
      return first().then(onfulfilled, onrejected);
    },
    async *[Symbol.asyncIterator]() {
      const seen = new Set<string>();

      if (initialCursor !== undefined) seen.add(initialCursor);

      let page = await first();

      while (true) {
        const nextCursor = page.meta.exhausted
          ? undefined
          : page.meta.continuationCursor;

        if (nextCursor !== undefined) {
          if (seen.has(nextCursor)) throw new ReadError('incomplete');

          seen.add(nextCursor);
        }

        yield* page.data;

        if (nextCursor === undefined) return;

        page = await fetchPage(nextCursor);
      }
    },
  };
}
