import type { Json } from '@relate/protocol';
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
  readonly observation: Observation;
}

export type Acceptance = 'changed' | 'unchanged' | 'superseded' | 'replay';

/** Storage adapter shape; behavioral requirements live in @relate/runtime/STORE_CONTRACT.md. */
export interface ObservationStore {
  /** Optional capability: source-only adapters remain valid for read-only graphs. */
  readonly native?: NativeStore;
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
    },
  ): Promise<{ object: StoredObject; acceptance: Acceptance }>;
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

export interface NativeInvocation {
  readonly actionDefinitionId: string;
  readonly idempotencyKey: string;
  /** Null only for legacy invocations, which cannot be recovered by consumers. */
  readonly actorId: string | null;
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

export interface NativeTransaction {
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
