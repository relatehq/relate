/**
 * The playground's requests to `relate dev`: a principal's discovery and a
 * run. Both answers are validated against the protocol before use. A run is
 * cancelled by aborting its signal, which closes the request and stops the
 * execution in the dev server.
 */
import {
  playgroundDiscoverySchema,
  playgroundErrorSchema,
  playgroundRunSchema,
} from '../protocol.js';
import type { PlaygroundDiscovery, PlaygroundRun } from '../protocol.js';

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export interface PlaygroundClient {
  discovery(principal: string): Promise<Answer<PlaygroundDiscovery>>;
  run(
    principal: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<Answer<PlaygroundRun>>;
}

export function createPlaygroundClient(options: {
  /** Base URL of the mounted inspector; dev endpoints are relative to it. */
  readonly baseUrl: URL;
  readonly fetch?: typeof fetch;
}): PlaygroundClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const url = (path: string) => new URL(path, options.baseUrl).href;

  async function answer<T>(
    request: () => Promise<Response>,
    parse: (payload: unknown) => T | null,
  ): Promise<Answer<T>> {
    let response: Response;

    try {
      response = await request();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError')
        return { ok: false, error: 'Cancelled', retryable: false };

      return {
        ok: false,
        error: 'Could not reach relate dev',
        retryable: true,
      };
    }

    let payload: unknown = null;

    try {
      payload = await response.json();
    } catch {
      // Reported below as an unreadable answer.
    }

    if (response.ok) {
      const value = parse(payload);

      return value === null
        ? {
            ok: false,
            error: 'relate dev sent an answer this inspector cannot read',
            retryable: false,
          }
        : { ok: true, value };
    }

    const failure = playgroundErrorSchema.safeParse(payload);

    return failure.success
      ? {
          ok: false,
          error: failure.data.error,
          retryable: failure.data.retryable ?? false,
        }
      : {
          ok: false,
          error: `relate dev refused the request (${response.status})`,
          retryable: false,
        };
  }

  return {
    discovery: (principal) =>
      answer(
        () =>
          fetchImpl(
            url(`dev/playground/discovery?as=${encodeURIComponent(principal)}`),
            { credentials: 'same-origin', cache: 'no-store' },
          ),
        (payload) => {
          const parsed = playgroundDiscoverySchema.safeParse(payload);

          return parsed.success ? parsed.data : null;
        },
      ),
    run: (principal, code, signal) =>
      answer(
        () =>
          fetchImpl(url('dev/playground/runs'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ principal, code }),
            cache: 'no-store',
            ...(signal ? { signal } : {}),
          }),
        (payload) => {
          const parsed = playgroundRunSchema.safeParse(payload);

          return parsed.success ? parsed.data : null;
        },
      ),
  };
}
