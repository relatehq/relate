/**
 * The host cannot bind a graph right now, for a reason the caller may see:
 * the runtime is restarting, or the actor is not served by it. Unlike other
 * host exceptions, which become sanitized tool failures, both tools forward
 * this message and `retryable`, so an agent can tell "wait and retry" from
 * "this will not work". Put nothing in the message you would not show the
 * caller.
 */
export class BindingUnavailableError extends Error {
  readonly code = 'binding-unavailable' as const;
  /** True when retrying later can succeed without the caller changing anything. */
  readonly retryable: boolean;

  constructor(message: string, options: { readonly retryable: boolean }) {
    super(message);
    this.name = 'BindingUnavailableError';
    this.retryable = options.retryable;
  }
}

/** Structural, so a host's separate module instance of this package still matches. */
export function isBindingUnavailable(
  error: unknown,
): error is BindingUnavailableError {
  return (
    error instanceof Error &&
    error.name === 'BindingUnavailableError' &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean'
  );
}
