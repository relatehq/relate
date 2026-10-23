import { compareObjectIds } from './storage.js';

/** First index whose object ID sorts after `after`, or 0 without a continuation. */
export function startAfter<T>(
  ordered: readonly T[],
  after: string | undefined,
  objectId: (item: T) => string,
) {
  let low = 0;
  let high = after === undefined ? 0 : ordered.length;

  while (low < high) {
    const middle = (low + high) >>> 1;

    if (compareObjectIds(objectId(ordered[middle]!), after!) > 0) high = middle;
    else low = middle + 1;
  }

  return low;
}
