import type {
  ActionReceipt,
  Json,
  ObjectRecord,
  ObjectResult,
  Page,
  QueryRequest,
  ReadRequest,
  TraversalRequest,
} from './index.js';
import type { Discovery } from './discovery.js';

/**
 * The consumer operations of one graph, bound to one authenticated actor and
 * addressed by definition IDs. This is the boundary every consumer surface
 * shares: the embedded engine implements it directly, `@relate/http` serves
 * it, and `@relate/client` implements it over a transport. The typed facade in
 * `relate/consumer` turns it into `objects.Customer.get(...)` calls.
 *
 * Implementations own authorization: a `not-found`, an empty page, a hidden
 * traversal or a denied action look the same to the caller whatever the cause.
 * Requests arrive unvalidated; an implementation rejects a malformed request
 * with `ReadError('invalid-request')` or `ActionError('invalid')`.
 */
export interface ConsumerOperations {
  /** Metadata available to this actor; a snapshot a remote caller can prefetch. */
  readonly discovery: Discovery;
  /** The complete public result, including the canonical `id`, or `not-found`. */
  get(
    objectDefinitionId: string,
    objectId: string,
    request?: ReadRequest,
  ): Promise<ObjectResult>;
  query(
    objectDefinitionId: string,
    request?: QueryRequest,
  ): Promise<Page<ObjectRecord>>;
  /** A to-one traversal yields an `ObjectResult`; a to-many traversal yields one page. */
  traverse(
    objectDefinitionId: string,
    objectId: string,
    traversal: string,
    request?: TraversalRequest,
  ): Promise<ObjectResult | Page<ObjectRecord>>;
  invoke(
    actionDefinitionId: string,
    request: { readonly input: Json; readonly idempotencyKey: string },
  ): Promise<ActionReceipt>;
  getReceipt(
    actionDefinitionId: string,
    invocationId: string,
  ): Promise<ActionReceipt>;
}
