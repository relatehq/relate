/** Trusted per-read controls, separate from consumer JSON and activity capture. */
export interface ReadExecution {
  readonly signal: AbortSignal;
  /** Charge exactly when a provider fetch or identity call is about to start. */
  beforeSourceCall(): void;
}
