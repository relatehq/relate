/**
 * The dev request a graph operation belongs to. `observeExecutor` binds it to
 * every operation agent code makes; the runtime binding reads it when it
 * assigns the operation's identity, so the runtime's rows and the dev log
 * share one operation ID and request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConsumerOperations } from '@relate/protocol';
import type { OperationContext } from '@relate/inspector/protocol';

const current = new AsyncLocalStorage<OperationContext>();

export const activityContext = (): OperationContext | undefined =>
  current.getStore();

/** Operations that run every call inside `context`, wherever the call comes from. */
export function withActivityContext(
  operations: ConsumerOperations,
  context: OperationContext,
): ConsumerOperations {
  const bind =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R =>
      current.run(context, () => call(...args));

  return Object.freeze({
    discovery: operations.discovery,
    get: bind(operations.get),
    query: bind(operations.query),
    traverse: bind(operations.traverse),
    invoke: bind(operations.invoke),
    getReceipt: bind(operations.getReceipt),
  } satisfies ConsumerOperations);
}
