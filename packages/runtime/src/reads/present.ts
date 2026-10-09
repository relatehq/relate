import { present } from '@relate/protocol';
import type { Presentable, Presented, ReadRequest } from '@relate/protocol';

/**
 * Runs a read and presents its result in the requested evidence mode. The read
 * receives a one-time snapshot of the request, and the mode comes from that same
 * snapshot, so presentation always matches what validation accepted.
 */
export async function presenting<R extends ReadRequest, T extends Presentable>(
  request: R,
  read: (request: R) => Promise<T>,
): Promise<Presented<T>> {
  // Non-objects pass through untouched so validation still rejects them.
  const snapshot =
    request && typeof request === 'object' && !Array.isArray(request)
      ? { ...request }
      : request;

  return present(await read(snapshot), snapshot?.evidence);
}
