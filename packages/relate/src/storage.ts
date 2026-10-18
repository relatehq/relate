import type {
  Change,
  ActivityActor,
  OperationContext,
  ActivityObjectRef,
  ObjectProvenance,
  Operation,
  FeedEntry,
  ActivityReadOptions,
  FeedFilter,
  OperationFilter,
  ActivityPage,
  Json,
} from '@relate/protocol';
import type { SourceVersion } from './connectors.js';

export type { SourceVersion } from './connectors.js';

export interface StorageScope {
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly objectDefinitionId: string;
  readonly sourceDefinitionId: string;
  readonly connectionId: string;
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
  readonly provenance?: ObjectProvenance;
  readonly observation: Observation;
}

export type Acceptance = 'changed' | 'unchanged' | 'superseded' | 'replay';

/** Storage adapter shape; behavioral requirements live in @relate/runtime/STORE_CONTRACT.md. */
export interface ObservationStore {
  /** Optional capability: source-only adapters remain valid for read-only graphs. */
  readonly native?: NativeStore;
  readonly activity?: ActivityStore;
  /** Declares atomic acceptance/feed support; required when activity is advertised. */
  readonly atomicActivity?: true;
  provenance(
    scope: StorageScope,
    objectId: string,
  ): Promise<ObjectProvenance | undefined>;
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
  /** Atomically registers membership when adopt=true, orders and retains the complete observation. */
  accept(
    scope: StorageScope,
    input: {
      sourceRecordId: string;
      objectId?: string;
      adopt: boolean;
      observation: Observation;
      provenance?: AcceptanceProvenance | undefined;
    },
  ): Promise<{
    object: StoredObject;
    acceptance: Acceptance;
    change?: Pick<Change, 'kind' | 'changedPropertyIds'>;
  }>;
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
  readonly provenance?: ObjectProvenance;
}

export interface NativeInvocation {
  readonly actionDefinitionId: string;
  readonly idempotencyKey: string;
  /** Null only for legacy invocations, which cannot be recovered by consumers. */
  readonly actorId: string | null;
  readonly activity?: InvocationAttribution;
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
  appendFeed?(drafts: readonly FeedDraft[]): Promise<void>;
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
  insert(record: NativeRecord): Promise<void>;
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
}

export interface NativeStore {
  readonly atomicActivity?: true;
  provenance(
    scope: NativeScope,
    object: ActivityObjectRef,
  ): Promise<ObjectProvenance | undefined>;
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
  /** Atomically commit all inserts and invocation evidence; any error rolls back. */
  transaction<T>(
    scope: NativeScope,
    operation: (transaction: NativeTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Metadata only; adapters assign publication position and recording time. */
type Draft<T> = T extends unknown ? Omit<T, 'recordedAt' | 'position'> : never;

export type FeedDraft = Draft<FeedEntry>;
export type OperationDraft = Draft<Operation>;

export interface InvocationAttribution {
  readonly actor: ActivityActor;
  readonly operationId: string;
  readonly context: OperationContext;
  readonly definitionRevision: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface AcceptanceProvenance {
  readonly actor: Exclude<ActivityActor, { kind: 'source' }>;
  readonly operationId: string;
  readonly parentOperationId?: string;
  readonly context: OperationContext;
  readonly occurredAt: string;
  readonly changeId: string;
}

export interface ActivityStore {
  status(graphId: string): Promise<{
    readonly state: 'available';
    readonly durability: 'volatile' | 'persistent';
  }>;
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

export interface ActivityCaptureOptions {
  readonly enabled?: boolean;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxObjects?: number;
  readonly batchEntries?: number;
  readonly flushTimeoutMs?: number;
  readonly onError?: (diagnostic: ActivityDiagnostic) => void;
}

export interface ActivityDiagnostic {
  readonly code: 'overflow' | 'write-failed' | 'shutdown' | 'truncated';
  readonly count: number;
  readonly kinds: readonly Operation['kind'][];
}
