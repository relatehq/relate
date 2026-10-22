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
  read(input: {
    readonly attempt: OperationScope;
    readonly principal: Principal;
    readonly objectType: string;
    readonly id: string;
    readonly request: ReadRequest;
    readonly execution?: ReadExecution;
  }): Promise<OrdinaryReadResult>;
  query(input: {
    readonly attempt: OperationScope;
    readonly principal: Principal;
    readonly objectType: string;
    readonly request: QueryRequest;
    readonly context?: QueryContext;
  }): Promise<FullPageResult>;
}
