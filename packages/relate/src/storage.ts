import type {
  ActivityActor,
  ActivityObjectRef,
  ActivityPage,
  ActivityReadOptions,
  Change,
  FeedEntry,
  FeedFilter,
  InvocationEvent,
  Json,
  ObjectProvenance,
  Operation,
  OperationActor,
  OperationKind,
  OperationContext,
  OperationFilter,
} from '@relate/protocol';
import type { SourceVersion } from './connectors.js';

export type { SourceVersion } from './connectors.js';

export interface StorageScope {
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly objectDefinitionId: string;
  readonly sourceDefinitionId: string;
  readonly connectionId: string;
  readonly resourceId: string;
  /** Null means application-owned connection identity, distinct from every verified account. */
  readonly providerAccountId: string | null;
  readonly partition: 'shared-service';
}

export interface Observation {
  readonly state: 'present' | 'deleted';
  readonly raw: Record<string, Json>;
  /** Mapped values keyed by stable property definition ID, never by API name. */
  readonly values: Record<string, Json>;
  readonly observedAt: number;
  readonly token: string;
  readonly version?: SourceVersion;
}

export interface StoredObject {
  readonly objectId: string;
  readonly sourceRecordId: string;
  readonly observation: Observation;
}

export type Acceptance = 'changed' | 'unchanged' | 'superseded' | 'replay';

/**
 * Trusted attribution for one acceptance, supplied by the runtime. Adoption
 * provenance is written from it on first membership whether or not the store
 * supports activity; a change is recorded only when it does.
 */
export interface AcceptAttribution {
  /** Preassigned ID of the change this acceptance may record. */
  readonly changeId: string;
  /** The adopt or refresh attempt; its operation row may not exist. */
  readonly operationId: string;
  readonly parentOperationId?: string;
  /** The adopting actor, or the actor whose operation triggered a refresh. */
  readonly actor: OperationActor;
  readonly context: OperationContext;
  /** Epoch milliseconds; when Relate observed the transition. */
  readonly occurredAt: number;
}

/** The business-state transition decided under the acceptance lock. */
export interface AcceptedChange {
  readonly id: string;
  readonly kind: Exclude<Change['kind'], 'created'>;
  readonly changedPropertyIds: readonly string[];
}

/** Storage adapter shape; behavioral requirements live in @relate/runtime/STORE_CONTRACT.md. */
export interface ObservationStore {
  /** Optional capability: source-only adapters remain valid for read-only graphs. */
  readonly native?: NativeStore;
  /**
   * Optional capability: the durable feed and best-effort operation history.
   * Advertising it promises atomic feed recording for every write capability.
   */
  readonly activity?: ActivityStore;
  /** Whether confirmed retention survives process restart; not a write outcome. */
  readonly durability: 'volatile' | 'persistent';
  /** Pins an installed instance. Definition changes require explicit migration. */
  install(graphId: string, definitionRevision: string): Promise<void>;
  /** Unique, increasing integer tokens shared by all clients of the same backing store. */
  beginFetch(): Promise<string>;
  /** Returns an isolated snapshot in this exact scope, or undefined. */
  load(
    scope: StorageScope,
    objectId: string,
  ): Promise<StoredObject | undefined>;
  /**
   * Batched `load` of at most 100 IDs: isolated snapshots keyed by object ID.
   * IDs absent in this exact scope are omitted.
   */
  loadMany(
    scope: StorageScope,
    objectIds: readonly string[],
  ): Promise<ReadonlyMap<string, StoredObject>>;
  /** Lookup only: resolve an existing source identity in the exact scope. Never adopts. */
  resolve(
    scope: StorageScope,
    sourceRecordId: string,
  ): Promise<StoredObject | undefined>;
  /** Bounded ordered enumeration of adopted identities, including tombstones. No source I/O. */
  scan(
    scope: StorageScope,
    options: { after?: string; limit: number },
  ): Promise<{ objects: readonly StoredObject[]; hasMore: boolean }>;
  /**
   * Atomically registers membership when adopt=true, orders and retains the
   * complete observation. A winning acceptance classifies its transition with
   * `describeAcceptedChange` under the same lock and, when activity is
   * supported, records that change atomically with the observation.
   */
  accept(
    scope: StorageScope,
    input: {
      sourceRecordId: string;
      objectId?: string;
      adopt: boolean;
      observation: Observation;
      attribution: AcceptAttribution;
    },
  ): Promise<{
    object: StoredObject;
    acceptance: Acceptance;
    /** Present exactly when this acceptance changed business state. */
    change?: AcceptedChange;
  }>;
  /** Adoption provenance from the object row; undefined when the object is absent. */
  provenance(
    scope: StorageScope,
    objectId: string,
  ): Promise<ObjectProvenance | undefined>;
}

export interface NativeScope {
  readonly graphId: string;
  readonly definitionRevision: string;
}

export interface NativeRecord {
  readonly objectDefinitionId: string;
  readonly objectId: string;
  /** Stable property definition IDs, never authoring property names. */
  readonly values: Readonly<Record<string, import('@relate/protocol').Json>>;
  readonly createdAt: number;
}

/** Creation provenance stored on a native object row for its lifetime. */
export interface NativeCreation {
  readonly actor: OperationActor;
  readonly invocationId: string;
}

export interface NativeInvocation {
  readonly actionDefinitionId: string;
  readonly idempotencyKey: string;
  /** Null only for legacy invocations, which cannot be recovered by consumers. */
  readonly actorId: string | null;
  /** Attempt metadata; null for legacy invocations, never inferred. */
  readonly actorKind?: OperationActor['kind'] | null;
  readonly operationId?: string | null;
  readonly requestId?: string | null;
  readonly transport?: OperationContext['transport'] | null;
  readonly definitionRevision?: string | null;
  /** Epoch milliseconds. */
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
  readonly reads: readonly NativeReceiptRead[] | null;
  readonly input: import('@relate/protocol').Json;
  readonly receipt: import('@relate/protocol').ActionReceipt;
}

/** Authorization dependencies of saved output, keyed by stable definition IDs. */
export interface NativeReceiptRead {
  readonly objectDefinitionId: string;
  readonly objectId: string;
  readonly propertyIds: readonly string[];
}

/** Strictly ascending object-ID scan, scoped to one native object type. */
// TODO(performance): Add indexed native candidate selection backed by author-declared
// indexes, with memory/Postgres parity and transactional read-your-writes/rollback.
// Preserve scoped cursor ordering; candidate selection must not grant authorization.
export interface NativeScanOptions {
  readonly after?: string;
  readonly limit: number;
}

export interface NativeScanResult {
  readonly objects: readonly NativeRecord[];
  readonly hasMore: boolean;
}

export interface NativeTransaction {
  /** Includes this transaction's earlier inserts. */
  scan(
    objectDefinitionId: string,
    options: NativeScanOptions,
  ): Promise<NativeScanResult>;
  /** Roll back this callback's writes on rejection, retaining the outer transaction and key claim. */
  savepoint<T>(operation: () => Promise<T>): Promise<T>;
  load(
    objectDefinitionId: string,
    objectId: string,
  ): Promise<NativeRecord | undefined>;
  /** Store creation provenance on the object row in the same write. */
  insert(record: NativeRecord, creation: NativeCreation): Promise<void>;
  /** Atomically reserve a new key, or return the original committed invocation. */
  claim(
    actionDefinitionId: string,
    idempotencyKey: string,
  ): Promise<NativeInvocation | undefined>;
  findInvocation(
    actionDefinitionId: string,
    invocationId: string,
  ): Promise<NativeInvocation | undefined>;
  saveInvocation(invocation: NativeInvocation): Promise<void>;
  /**
   * Stage ordered feed drafts. Staging follows savepoint rollback and handle
   * revocation; the adapter publishes the staged batch as the final work
   * before COMMIT. Required when the store advertises activity.
   */
  appendFeed?(drafts: readonly FeedDraft[]): Promise<void>;
}

export interface NativeStore {
  scan(
    scope: NativeScope,
    objectDefinitionId: string,
    options: NativeScanOptions,
  ): Promise<NativeScanResult>;
  /** Trusted storage evidence; never expose without runtime receipt authorization. */
  loadInvocation(
    scope: NativeScope,
    actionDefinitionId: string,
    idempotencyKey: string,
  ): Promise<NativeInvocation | undefined>;
  load(
    scope: NativeScope,
    objectDefinitionId: string,
    objectId: string,
  ): Promise<NativeRecord | undefined>;
  /** Creation provenance from the object row; undefined when the object is absent. */
  provenance(
    scope: NativeScope,
    object: ActivityObjectRef,
  ): Promise<ObjectProvenance | undefined>;
  /** Atomically commit all inserts and invocation evidence; any error rolls back. */
  transaction<T>(
    scope: NativeScope,
    operation: (transaction: NativeTransaction) => Promise<T>,
  ): Promise<T>;
}

type Unpositioned<T> = T extends unknown
  ? Omit<T, 'position' | 'recordedAt'>
  : never;

/** A feed entry before the adapter assigns its position and recording time. */
export type FeedDraft = Unpositioned<FeedEntry>;
export type ChangeDraft = Unpositioned<Change>;
export type InvocationEventDraft = Unpositioned<InvocationEvent>;

type WithoutRecordedAt<T> = T extends unknown ? Omit<T, 'recordedAt'> : never;

/** An operation before the adapter assigns its recording time. */
export type OperationDraft = WithoutRecordedAt<Operation>;

/**
 * Methods take the graph ID; the host activity reader binds its graph. Feed
 * entries have the durability of the owning store.
 */
export interface ActivityStore {
  /**
   * The write capabilities whose feed entries this adapter records atomically.
   * Runtime setup rejects a store whose exposed writes are not all covered.
   */
  readonly atomicFeed: {
    readonly sourceAcceptance: boolean;
    readonly nativeTransactions: boolean;
  };
  /**
   * Best effort, first-write-wins by operation ID: an append inserts each new
   * operation with all of its lineage atomically and never amends an existing
   * row. Never part of a committing domain transaction.
   */
  appendOperations(
    graphId: string,
    drafts: readonly OperationDraft[],
  ): Promise<void>;
  readonly feed: {
    read(
      graphId: string,
      options?: ActivityReadOptions<FeedFilter>,
    ): Promise<ActivityPage<FeedEntry>>;
  };
  readonly operations: {
    list(
      graphId: string,
      options?: ActivityReadOptions<OperationFilter>,
    ): Promise<ActivityPage<Operation>>;
  };
}

/** Operation capture limits. Defaults are documented in the runtime README. */
export interface ActivityCaptureOptions {
  /** Disabling operation capture never disables the feed or object provenance. */
  readonly operations?: 'enabled' | 'disabled';
  /** Queued and in-flight operations; defaults to 1,000. */
  readonly queueEntries?: number;
  /** Queued and in-flight UTF-8 JSON bytes; defaults to 8 MiB. */
  readonly queueBytes?: number;
  /** Operations per append; defaults to 100. */
  readonly batchEntries?: number;
  /** Lineage entries kept per operation before truncation; defaults to 1,000. */
  readonly maxObjects?: number;
  /** Largest single operation in UTF-8 JSON bytes; defaults to 256 KiB. */
  readonly maxOperationBytes?: number;
  /** Shutdown flush deadline for queued operations; defaults to 5,000 ms. */
  readonly flushTimeoutMs?: number;
  /** Notified of drops and truncation. Its failures never affect operations. */
  readonly onDiagnostic?: (diagnostic: ActivityDiagnostic) => void;
}

export type ActivityDropReason =
  'queue-full' | 'append-failed' | 'oversized' | 'invalid' | 'shutdown';

/** Sanitized: operation kinds and counts only, never IDs, values or messages. */
export type ActivityDiagnostic =
  | {
      readonly type: 'dropped';
      readonly reason: ActivityDropReason;
      readonly count: number;
      readonly kinds: readonly OperationKind[];
    }
  | {
      readonly type: 'truncated';
      readonly kind: OperationKind;
      readonly omittedObjects: number;
    };

export type { ActivityActor, ObjectProvenance };
