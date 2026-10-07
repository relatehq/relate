/**
 * Browser client for the development channel: session bootstrap, snapshot
 * fetch and the SSE stream with duplicate/gap handling and resynchronization.
 */
import { parseDevEvent, ProtocolError } from '../protocol.js';
import {
  applyEvent,
  initialState,
  markConnection,
  markStale,
  setLayoutDiagnostic,
} from './store.js';
import type { InspectorState } from './store.js';
import type { Diagnostic } from '../protocol.js';

export interface DevClient {
  readonly getState: () => InspectorState;
  readonly subscribe: (listener: () => void) => () => void;
  start(): Promise<void>;
  stop(): void;
  resync(): Promise<void>;
  setLayoutDiagnostic(diagnostic: Diagnostic | null): void;
}

export interface DevClientOptions {
  /** Base URL of the mounted inspector; dev endpoints are relative to it. */
  readonly baseUrl: URL;
  /** Fragment token from the terminal link, if present. */
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly createEventSource?: (url: string) => EventSource;
  readonly retryDelaysMs?: readonly number[];
}

const defaultRetries = [1_000, 2_000, 4_000, 8_000, 10_000];

export function createDevClient(options: DevClientOptions): DevClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const createEventSource =
    options.createEventSource ?? ((url) => new EventSource(url));
  const retries = options.retryDelaysMs ?? defaultRetries;
  const listeners = new Set<() => void>();
  const url = (path: string) => new URL(path, options.baseUrl).toString();
  let state: InspectorState = initialState;
  let stream: EventSource | null = null;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const update = (next: InspectorState) => {
    if (next === state) return;

    state = next;

    for (const listener of listeners) listener();
  };
  const closeStream = () => {
    stream?.close();
    stream = null;
  };
  const halt = (next: InspectorState) => {
    closeStream();

    if (retryTimer) clearTimeout(retryTimer);

    retryTimer = null;
    update(next);
  };

  /** Fetch the authoritative snapshot; returns false when the client must stop. */
  const fetchSnapshot = async (): Promise<boolean> => {
    let response: Response;

    try {
      response = await fetchImpl(url('dev/snapshot'), {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
    } catch {
      return true;
    }

    if (response.status === 401 || response.status === 403) {
      // A restarted supervisor invalidates the cookie: keep the graph as stale.
      halt(
        state.model || state.failure
          ? markStale(state, 'session')
          : { ...state, connection: 'unauthorized' },
      );

      return false;
    }

    if (!response.ok) return true;

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      return true;
    }

    return applyPayload(payload);
  };
  const applyPayload = (payload: unknown): boolean => {
    let event;

    try {
      event = parseDevEvent(payload);
    } catch (error) {
      if (
        error instanceof ProtocolError &&
        error.reason === 'unsupported-version'
      ) {
        halt(markStale(state, 'protocol', error.protocolVersion));

        return false;
      }

      // An invalid payload from a compatible supervisor: resynchronize.
      void resync();

      return true;
    }

    const { state: next, outcome } = applyEvent(state, event);

    update(next);

    if (outcome === 'gap') void resync();

    return true;
  };
  const scheduleRetry = () => {
    if (stopped || retryTimer || state.connection === 'stale') return;

    const delay = retries[Math.min(attempt, retries.length - 1)] ?? 10_000;

    attempt += 1;
    retryTimer = setTimeout(async () => {
      retryTimer = null;

      if (stopped) return;

      if (await fetchSnapshot()) {
        if (state.connection === 'live') {
          attempt = 0;
          openStream();
        } else scheduleRetry();
      }
    }, delay);
  };
  const openStream = () => {
    if (stopped || stream) return;

    const source = createEventSource(url('dev/events'));

    stream = source;
    source.onmessage = (message) => {
      if (stream !== source) return;

      let payload: unknown;

      try {
        payload = JSON.parse(String(message.data));
      } catch {
        return;
      }

      applyPayload(payload);
    };
    source.onerror = () => {
      if (stream !== source) return;

      closeStream();

      if (state.connection === 'stale' || state.connection === 'unauthorized')
        return;

      update(markConnection(state, 'reconnecting'));
      scheduleRetry();
    };
  };
  const resync = async () => {
    if (stopped) return;

    closeStream();

    if (await fetchSnapshot()) {
      if (state.connection === 'live') openStream();
      else scheduleRetry();
    }
  };
  const bootstrap = async (): Promise<boolean> => {
    if (!options.token) return true;

    let response: Response;

    try {
      response = await fetchImpl(url('dev/session'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: options.token }),
      });
    } catch {
      return true;
    }

    if (!response.ok) {
      update({ ...state, connection: 'unauthorized' });

      return false;
    }

    return true;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      stopped = false;

      if (!(await bootstrap())) return;

      if (await fetchSnapshot()) {
        if (state.connection === 'live') openStream();
        else {
          update(markConnection(state, 'reconnecting'));
          scheduleRetry();
        }
      }
    },
    stop() {
      stopped = true;
      halt(state);
    },
    resync,
    setLayoutDiagnostic(diagnostic) {
      update(setLayoutDiagnostic(state, diagnostic));
    },
  };
}

/** Read `#token=...` and remove it from the address bar before anything else runs. */
export function takeFragmentToken(
  location: Location,
  history: History,
): string | undefined {
  const match = /^#token=([A-Za-z0-9_-]+)$/.exec(location.hash);

  if (!match) return undefined;

  history.replaceState(null, '', location.pathname + location.search);

  return match[1];
}

/** The document URL with a trailing slash is the mount; dev endpoints hang off it. */
export function inspectorBaseUrl(location: Location): URL {
  const path = location.pathname.endsWith('/')
    ? location.pathname
    : `${location.pathname}/`;

  return new URL(path, location.origin);
}
