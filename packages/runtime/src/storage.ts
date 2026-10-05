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
