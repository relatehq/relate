import type { Json } from '@relate/protocol';

export interface SourceVersion {
  readonly domain: string;
  readonly value: string;
}

/** Account identity must come from this response or its authenticated, immutable credential context. */
export type SourceRecord = { readonly providerAccountId: string } & (
  | { state: 'present'; record: Record<string, Json>; version?: SourceVersion }
  | { state: 'deleted'; version?: SourceVersion }
);

/** Adapter for one selected system resource, such as a table or API resource. */
export interface SourceConnector {
  /** Authenticate current credentials and return the provider's stable account ID, never a configured label. */
  identify(options: { signal: AbortSignal }): Promise<string>;
  /** Deletion requires affirmative evidence. Throw SourceAccessDenied for explicit provider denial. */
  fetch(
    sourceRecordId: string,
    options: { signal: AbortSignal },
  ): Promise<SourceRecord>;
}

/** Provider permission denial must never be treated as temporary unavailability. */
export class SourceAccessDenied extends Error {
  constructor() {
    super('Source access denied');
    this.name = 'SourceAccessDenied';
  }
}

export interface SourceBinding {
  readonly connectionId: string;
  /** Expected stable provider account ID, checked against authenticated connector evidence. */
  readonly providerAccountId: string;
  readonly authorization: 'shared-service';
  readonly connector: SourceConnector;
}
