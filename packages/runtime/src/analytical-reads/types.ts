import type {
  FullObjectResult,
  FullPageResult,
  QueryRequest,
  ReadRequest,
} from '@relate/protocol';
import type { Manifest } from 'relate/model';
import type { AnalyticalLimits, SqlParser } from 'relate/analytics';
import type { AnalyticalBinding } from '../analytics/index.js';
import type { ReadExecution } from '../reads/index.js';
import type { OperationScope } from '../activity/index.js';
import type { Principal } from '../authorization/index.js';
import type { QueryContext, QueryCursors } from '../queries/index.js';

export type AnalyticalReadMode = 'get' | 'enrich-page' | 'rank-scope';

export interface AnalyticalReadOptions {
  readonly limits?: AnalyticalLimits;
  readonly parser: SqlParser;
  readonly binding: (datasetId: string) => AnalyticalBinding;
  readonly signal: AbortSignal;
}

export interface OrdinaryReadInput {
  readonly attempt: OperationScope;
  readonly principal: Principal;
  readonly objectType: string;
  readonly id: string;
  readonly request: ReadRequest;
  readonly execution?: ReadExecution;
}

/** The authorization check stays deferred until the caller is ready to publish. */
export interface OrdinaryReadResult {
  readonly result: FullObjectResult;
  recheckAuthorization(): Promise<boolean>;
}

export interface AnalyticalReadDependencies {
  readonly manifest: Manifest;
  readonly cursors: QueryCursors;
  readonly analytics?: AnalyticalReadOptions;
  clock(): number;
  read(input: OrdinaryReadInput): Promise<OrdinaryReadResult>;
  /**
   * Load up to 100 objects in one store call and return an ordinary `read`
   * that starts from those snapshots. Every read still refreshes, authorizes
   * and projects as `read` does; IDs the batch did not load fall back to it.
   */
  readBatch(input: {
    readonly objectType: string;
    readonly ids: readonly string[];
  }): Promise<(input: OrdinaryReadInput) => Promise<OrdinaryReadResult>>;
  query(input: {
    readonly attempt: OperationScope;
    readonly principal: Principal;
    readonly objectType: string;
    readonly request: QueryRequest;
    readonly context?: QueryContext;
  }): Promise<FullPageResult>;
}
