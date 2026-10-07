import type { Json } from '@relate/protocol';

export interface StorageScope {
  readonly graphId: string;
  readonly definitionRevision: string;
  readonly objectDefinitionId: string;
  readonly sourceDefinitionId: string;
  readonly connectionId: string;
  readonly partition: 'shared-service';
}

export interface SourceVersion {
  readonly domain: string;
  readonly value: string;
}

export interface Observation {
  readonly state: 'present' | 'deleted';
  readonly raw: Record<string, Json>;
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

/** Public adapter contract. See STORE_CONTRACT.md for atomicity and isolation requirements. */
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

export class RetentionError extends Error {
  constructor(
    readonly outcome: 'failed' | 'unconfirmed',
    options?: ErrorOptions,
  ) {
    super('Observation retention did not complete normally', options);
    this.name = 'RetentionError';
  }
}

export { compareObservation, OrderingConflict } from './observations/index.js';

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
  readonly input: import('@relate/protocol').Json;
  readonly receipt: import('@relate/protocol').SucceededReceipt;
}

export interface NativeTransaction {
  load(
    objectDefinitionId: string,
    objectId: string,
  ): Promise<NativeRecord | undefined>;
  insert(record: NativeRecord): Promise<void>;
  /** Reserve once per graph/action/key. Duplicate keys reject in this slice. */
  claim(actionDefinitionId: string, idempotencyKey: string): Promise<void>;
  saveInvocation(invocation: NativeInvocation): Promise<void>;
}

export interface NativeStore {
  /** Trusted storage evidence; consumer receipt authorization is a separate future operation. */
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

export class NativeConflict extends Error {}

/** Temporary storage failure. For native writes, COMMIT must not have succeeded. */
export class StorageUnavailable extends Error {
  constructor(options?: ErrorOptions) {
    super('Storage unavailable', options);
    this.name = 'StorageUnavailable';
  }
}

/** A lost COMMIT acknowledgement cannot be described as a confirmed rollback. */
export class NativeCommitUncertain extends Error {}
