/** Host-owned budgets; consumer requests cannot raise them. */
export interface AnalyticalLimits {
  /** Whole analytical operation, including enumeration and final checks. Default: 60,000 ms. */
  readonly operationTimeoutMs?: number;
  /** Provider fetch and identity calls, including authorization dependencies. Default: 50,000. */
  readonly maxSourceCalls?: number;
}
