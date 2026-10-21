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
}
