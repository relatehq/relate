/**
 * One `(runtimeId, principal)` view of the runtime host as `ConsumerOperations`.
 *
 * `@relate/mcp` and `relate/consumer` read discovery synchronously, so IPC
 * cannot answer it lazily: the binding fetches the principal's complete
 * discovery snapshot once, then serves discovery from it alongside IPC
 * operations pinned to its `runtimeId`. It is transport-independent; `/mcp`
 * and a future `/api` share the same binding.
 *
 * Each operation gets a fresh operation ID here, the routing boundary, and
 * carries the dev request it belongs to (`operationsFor`). The runtime
 * records the operation under that ID, so its row joins the dispatch event
 * this binding records.
 */
import { randomUUID } from 'node:crypto';
import type { ConsumerDescription } from 'relate/consumer';
import type { ConsumerOperations, Discovery } from '@relate/protocol';
import type { OperationContext } from '@relate/inspector/protocol';
import {
  discoverySnapshotSchema,
  type DiscoverySnapshot,
  type RuntimeOperation,
  type RuntimeRequest,
} from './runtime-protocol.js';
import { uuidv7 } from '@relate/runtime';
import { observeDispatch } from './activity/dispatch.js';
import type { ActivityLog } from './activity/log.js';

export interface RuntimeBinding {
  readonly runtimeId: string;
  readonly definitionRevision: string;
  readonly principal: string;
  /** The routing description from the runtime's own compile. */
  readonly description: ConsumerDescription;
  /** Prefetched discovery plus IPC calls pinned to `runtimeId`. */
  readonly operations: ConsumerOperations;
  /** The same operations, each call recorded under the dev `request`. */
  operationsFor(request: OperationContext): ConsumerOperations;
}

/** The dev server's channel to one runtime host. */
export interface RuntimeConnection {
  readonly runtimeId: string;
  /**
   * Send one request to this runtime. Rejects with `runtime-retired` once the
   * runtime is retired; the request is never redirected or replayed.
   */
  request(
    request:
      | {
          readonly type: 'op';
          readonly principal: string;
          readonly operation: RuntimeOperation;
          readonly attempt: Extract<RuntimeRequest, { type: 'op' }>['attempt'];
          readonly args: readonly unknown[];
        }
      | { readonly type: 'discovery'; readonly principal: string },
  ): Promise<unknown>;
}

/** JSON turns a trailing `undefined` argument into `null`; omit it instead. */
function trimmed(args: readonly unknown[]): unknown[] {
  const copy = [...args];

  while (copy.length && copy.at(-1) === undefined) copy.pop();

  return copy;
}

export function snapshotDiscovery(snapshot: DiscoverySnapshot): Discovery {
  return Object.freeze({
    describe: () => snapshot.overview,
    describeObject: (objectDefinitionId: string) =>
      Object.hasOwn(snapshot.objects, objectDefinitionId)
        ? snapshot.objects[objectDefinitionId]
        : undefined,
    describeAction: (actionDefinitionId: string) =>
      Object.hasOwn(snapshot.actions, actionDefinitionId)
        ? snapshot.actions[actionDefinitionId]
        : undefined,
  });
}

export async function createRuntimeBinding(options: {
  readonly connection: RuntimeConnection;
  readonly definitionRevision: string;
  readonly principal: string;
  readonly description: ConsumerDescription;
  /** Records each dispatched operation; runtime rows merge into it. */
  readonly activity?: ActivityLog;
}): Promise<RuntimeBinding> {
  const { connection, principal } = options;
  const raw = await connection.request({ type: 'discovery', principal });
  const parsed = discoverySnapshotSchema.safeParse(raw);

  if (!parsed.success)
    throw new Error('The runtime host returned an invalid discovery snapshot');

  const snapshot = parsed.data as unknown as DiscoverySnapshot;

  if (
    snapshot.overview.definitionRevision !== options.definitionRevision ||
    options.description.definitionRevision !== options.definitionRevision
  )
    throw new Error(
      'The runtime host discovery does not match the runtime revision',
    );

  const call =
    (operation: RuntimeOperation, request?: OperationContext) =>
    async (...args: unknown[]) => {
      const attempt = {
        operationId: uuidv7(),
        context: {
          requestId: request?.requestId ?? randomUUID(),
          transport: request?.transport ?? 'embedded',
          runtimeId: connection.runtimeId,
          ...(request?.executionId ? { executionId: request.executionId } : {}),
        },
      };
      // Outside a dev request there is no entry to show it under.
      const observed =
        options.activity && request
          ? observeDispatch(options.activity, {
              opId: attempt.operationId,
              context: { ...request, runtimeId: connection.runtimeId },
              operation,
              args,
            })
          : undefined;

      try {
        const value = await connection.request({
          type: 'op',
          principal,
          operation,
          attempt,
          args: trimmed(args),
        });

        observed?.succeeded();

        return value;
      } catch (error) {
        observed?.failed(error);

        throw error;
      }
    };
  const discovery = snapshotDiscovery(snapshot);
  const bind = (request?: OperationContext): ConsumerOperations =>
    Object.freeze({
      discovery,
      get: call('get', request),
      query: call('query', request),
      traverse: call('traverse', request),
      invoke: call('invoke', request),
      getReceipt: call('getReceipt', request),
    } as ConsumerOperations);

  return Object.freeze({
    runtimeId: connection.runtimeId,
    definitionRevision: options.definitionRevision,
    principal,
    description: options.description,
    operations: bind(),
    operationsFor: (request: OperationContext) => bind(request),
  });
}
