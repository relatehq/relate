export const DEFAULT_PORT_RANGE = Object.freeze({ from: 4318, to: 4327 });
export const DEFAULT_EVAL_TIMEOUT_MS = 30_000;

/** Node clamps larger timer values to 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

export class DevOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevOptionsError';
  }
}

/** Exact origin: scheme and host, optional port normalized to the scheme default. */
export function normalizeAllowedOrigin(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new DevOptionsError(
      `allowedOrigins must be an absolute origin; got ${value}`,
    );
  }

  const loopback =
    url.hostname === '127.0.0.1' ||
    url.hostname === 'localhost' ||
    url.hostname === '[::1]';

  if (
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    value.includes('*')
  )
    throw new DevOptionsError(
      `allowedOrigins accepts scheme and host only, no path, query, fragment, credentials or wildcard; got ${value}`,
    );

  if (url.protocol === 'http:' && !loopback)
    throw new DevOptionsError(
      `allowedOrigins requires HTTPS for remote origins; got ${value}`,
    );

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new DevOptionsError(
      `allowedOrigins must use http or https; got ${value}`,
    );

  return url.origin;
}

export function normalizeDevOptions(options: {
  readonly port?: number | undefined;
  readonly evalTimeoutMs?: number;
  readonly allowedOrigins?: readonly string[];
  readonly runtime?: boolean;
  readonly seed?: boolean;
  readonly rotateMcpToken?: boolean;
}) {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535)
  )
    throw new DevOptionsError('port must be an integer from 0 through 65535');

  const evalTimeoutMs = options.evalTimeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;

  if (
    !Number.isInteger(evalTimeoutMs) ||
    evalTimeoutMs < 1 ||
    evalTimeoutMs > MAX_TIMER_MS
  )
    throw new DevOptionsError(
      `evalTimeoutMs must be an integer from 1 through ${MAX_TIMER_MS}`,
    );

  const runtime = options.runtime ?? true;
  const seed = options.seed ?? false;

  if (seed && !runtime)
    throw new DevOptionsError('seed cannot be combined with runtime: false');

  return {
    port: options.port,
    evalTimeoutMs,
    allowedOrigins: [
      ...new Set((options.allowedOrigins ?? []).map(normalizeAllowedOrigin)),
    ],
    runtime,
    seed,
    rotateMcpToken: options.rotateMcpToken ?? false,
  };
}
