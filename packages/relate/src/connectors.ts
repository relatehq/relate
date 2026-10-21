import type { ScalarSchema } from '@relate/protocol';
import type { Json } from '@relate/protocol';

export interface SourceVersion {
  readonly domain: string;
  readonly value: string;
}

/**
 * Provider scope must come from this response or its authenticated, immutable
 * credential context. Include provider namespaces (for example test/live mode)
 * when account ID alone does not uniquely scope records.
 */
export type SourceRecord = { readonly providerAccountId: string } & SourceData;

export type ApplicationSourceRecord = {
  readonly providerAccountId?: never;
} & SourceData;

export type SourceResult = SourceRecord | ApplicationSourceRecord;

type SourceData =
  | { state: 'present'; record: Record<string, Json>; version?: SourceVersion }
  | { state: 'deleted'; version?: SourceVersion };

/** Provider-verified adapter for one selected table or API resource. */
export interface SourceConnector {
  readonly identity?: 'provider';
  /** Authenticate current credentials and return the stable provider scope used in fetch evidence, never a configured label. */
  identify(options: { signal: AbortSignal }): Promise<string>;
  /** Deletion requires affirmative evidence. Throw SourceAccessDenied for explicit provider denial. */
  fetch(
    sourceRecordId: string,
    options: { signal: AbortSignal },
  ): Promise<SourceRecord>;
}

export interface ApplicationSourceConnector {
  /** The application owns connection identity; no provider account is asserted. */
  readonly identity: 'application';
  readonly identify?: never;
  fetch(
    sourceRecordId: string,
    options: { signal: AbortSignal },
  ): Promise<ApplicationSourceRecord>;
}

export type AnySourceConnector = SourceConnector | ApplicationSourceConnector;

/** Provider permission denial must never be treated as temporary unavailability. */
export class SourceAccessDenied extends Error {
  constructor() {
    super('Source access denied');
    this.name = 'SourceAccessDenied';
  }
}

interface BindingOptions {
  readonly connectionId: string;
  /** Stable identity of the selected table or API resource within the connection. */
  readonly resourceId: string;
  readonly authorization: 'shared-service';
}

export type SourceBinding = BindingOptions &
  (
    | {
        readonly connector: SourceConnector;
        /** Expected stable provider scope, checked against connector evidence. May include a namespace such as test/live mode. */
        readonly providerAccountId: string;
      }
    | {
        readonly connector: ApplicationSourceConnector;
        readonly providerAccountId?: never;
      }
  );

/** One configured connection may supply several independently scoped resources. */
export interface ResourceConnection {
  readonly connectionId: string;
}

/** Source selection derives from the unbound definition when it is bound. */
export interface SourceSelection {
  readonly idField: string;
  readonly fields: readonly string[];
  /** Portable field encodings, when bound from an authored source definition. */
  readonly schemas?: Readonly<Record<string, ScalarSchema>>;
}

/** A selected resource exposes only the capabilities its connection implements. */
export interface SourceResource<
  C extends AnySourceConnector = AnySourceConnector,
> {
  readonly connection: ResourceConnection;
  readonly resourceId: string;
  bindSource(selection: SourceSelection): C;
}

export type {
  AnalyticalConnection,
  AnalyticalExecutionTiming,
  AnalyticalConnector,
  AnalyticalResource,
  AuthorizedDatasetQuery,
  DatasetExecution,
  DatasetResource,
  DatasetSelection,
  PhysicalColumn,
  PhysicalSchema,
  PreparedPlan,
  ResolvedAggregate,
  ResolvedOperand,
  ResolvedPredicate,
  SlotRow,
} from './analytics/connectors.js';

export { DatasetExecutionError } from './analytics/connectors.js';
export type { TypedValue } from './analytics/values.js';
