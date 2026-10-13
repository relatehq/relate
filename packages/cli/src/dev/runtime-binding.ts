/**
 * One `(runtimeId, principal)` view of the runtime host as `ConsumerOperations`.
 *
 * `@relate/mcp` and `relate/consumer` read discovery synchronously, so IPC
 * cannot answer it lazily: the binding fetches the principal's complete
 * discovery snapshot once, then serves discovery from it alongside IPC
 * operations pinned to its `runtimeId`. It is transport-independent; `/mcp`
 * and a future `/api` share the same binding.
 */
import type { ConsumerDescription } from 'relate/consumer';
import type { ConsumerOperations, Discovery } from '@relate/protocol';
import {
  discoverySnapshotSchema,
  type DiscoverySnapshot,
  type RuntimeOperation,
} from './runtime-protocol.js';

export interface RuntimeBinding {
  readonly runtimeId: string;
  readonly definitionRevision: string;
  readonly principal: string;
  /** The routing description from the runtime's own compile. */
  readonly description: ConsumerDescription;
  /** Prefetched discovery plus IPC calls pinned to `runtimeId`. */
  readonly operations: ConsumerOperations;
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
    (operation: RuntimeOperation) =>
    (...args: unknown[]) =>
      connection.request({
        type: 'op',
        principal,
        operation,
        args: trimmed(args),
      });
  const operations = {
    discovery: snapshotDiscovery(snapshot),
    get: call('get'),
    query: call('query'),
    traverse: call('traverse'),
    invoke: call('invoke'),
    getReceipt: call('getReceipt'),
  } as ConsumerOperations;

  return Object.freeze({
    runtimeId: connection.runtimeId,
    definitionRevision: options.definitionRevision,
    principal,
    description: options.description,
    operations: Object.freeze(operations),
  });
}
