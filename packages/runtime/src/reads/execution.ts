/** Trusted per-read controls, separate from consumer JSON and activity capture. */
export interface ReadExecution {
  readonly signal: AbortSignal;
  /** The owner validated caller selection before adding private dependencies. */
  readonly expandedSelection?: true;
  /** Charge exactly when a provider fetch or identity call is about to start. */
  beforeSourceCall(): void;
}
