/** Host-owned budgets; consumer requests cannot raise them. */
export interface AnalyticalLimits {
  /** Whole analytical operation, including enumeration and final checks. Default: 60,000 ms. */
  readonly operationTimeoutMs?: number;
  /** Provider fetch and identity calls, including authorization dependencies. Default: 100,000. */
  readonly maxSourceCalls?: number;
  /** Members scanned for a computed filter/order, including denied and nonmatching members. Default: 12,500. */
  readonly maxCandidatesScanned?: number;
  /** Authorized ordinary matches in a computed filter/order scope. Default: 10,000. */
  readonly maxCandidatesAdmitted?: number;
  /** UTF-8 SQL bytes per expression, declared or caller-provided. Default: 4096. */
  readonly maxSqlBytes?: number;
  /** Parsed syntax nodes per expression. Default: 256. */
  readonly maxParsedNodes?: number;
  /** Distinct named parameters per expression. Default: 16. */
  readonly maxParameters?: number;
  /** UTF-8 bytes in the JSON encoding of each named parameter value. Default: 1024. */
  readonly maxParameterBytes?: number;
  /** Combined selected/required declarations and caller expressions. Default: 8. */
  readonly maxExpressions?: number;
  /** Authorized object slots per statement, reduced by connector parameter capacity. Default: 1000. */
  readonly maxKeysPerStatement?: number;
  /** Execution time per statement, excluding queue wait and connector startup. Default: 5000 ms. */
  readonly statementTimeoutMs?: number;
  /** Concurrent statements per configured connection, shared by all actors and bindings. Default: 4. */
  readonly maxConcurrentStatements?: number;
  /** Pending statements per configured connection. Default: 32; zero rejects when all slots are busy. */
  readonly maxQueuedStatements?: number;
  /** Maximum queue wait. Default: 2000 ms; zero rejects rather than waiting. */
  readonly queueTimeoutMs?: number;
}
