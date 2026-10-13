/**
 * The built-in agent in the browser: the `/dev/agent/events` stream and the
 * turn requests. The loop and the API key stay in the dev server; this client
 * only shows conversations and asks for turns. Every payload is validated
 * against the protocol before it is used.
 *
 * Conversations are per development principal. The panel shows the one for
 * the principal selected in the header; a running turn keeps its principal
 * however the selector changes.
 */
import {
  agentErrorSchema,
  agentEventSchema,
  agentTurnAcceptedSchema,
} from '../protocol.js';
import type {
  AgentAvailability,
  AgentConversation,
  AgentEvent,
  AgentTurnAccepted,
} from '../protocol.js';

export interface AgentState {
  /** `stopped`: no inspector session, so no stream is open. */
  readonly connection: 'stopped' | 'connecting' | 'live' | 'reconnecting';
  /** Null until the first snapshot arrives. */
  readonly availability: AgentAvailability | null;
  readonly conversations: ReadonlyMap<string, AgentConversation>;
}

export const initialAgent: AgentState = Object.freeze({
  connection: 'stopped',
  availability: null,
  conversations: new Map(),
});

const emptyConversation = (principal: string): AgentConversation => ({
  principal,
  turn: null,
  messages: [],
});

/** Validate one stream payload; anything this inspector cannot read is null. */
export function parseAgentEvent(input: unknown): AgentEvent | null {
  const parsed = agentEventSchema.safeParse(input);

  return parsed.success ? parsed.data : null;
}

/** The state after one event. Messages are upserts; text events append. */
export function applyAgentEvent(
  state: AgentState,
  event: AgentEvent,
): AgentState {
  if (event.type === 'snapshot')
    return {
      ...state,
      availability: event.availability,
      conversations: new Map(
        event.conversations.map((entry) => [entry.principal, entry]),
      ),
    };

  const conversations = new Map(state.conversations);
  const current =
    conversations.get(event.principal) ?? emptyConversation(event.principal);

  switch (event.type) {
    case 'turn':
      conversations.set(event.principal, { ...current, turn: event.turn });
      break;
    case 'message': {
      const index = current.messages.findIndex(
        (message) => message.id === event.message.id,
      );
      const messages = [...current.messages];

      if (index === -1) messages.push(event.message);
      else messages[index] = event.message;

      conversations.set(event.principal, { ...current, messages });
      break;
    }
    case 'text': {
      const messages = current.messages.map((message) =>
        message.id === event.messageId && message.kind === 'assistant'
          ? { ...message, text: message.text + event.delta }
          : message,
      );

      conversations.set(event.principal, { ...current, messages });
      break;
    }
  }

  return { ...state, conversations };
}

export type SendResult =
  | { readonly ok: true; readonly turn: AgentTurnAccepted }
  | { readonly ok: false; readonly error: string };

export interface AgentClient {
  readonly getState: () => AgentState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Open the stream; idempotent. */
  start(): void;
  /** Close the stream and stop retrying; idempotent. */
  stop(): void;
  send(principal: string, text: string): Promise<SendResult>;
  cancel(turnId: string): Promise<SendResult>;
}

const defaultRetries = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export function createAgentClient(options: {
  readonly baseUrl: URL;
  readonly fetch?: typeof fetch;
  readonly createEventSource?: (url: string) => EventSource;
  readonly retryDelaysMs?: readonly number[];
}): AgentClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const createEventSource =
    options.createEventSource ?? ((url) => new EventSource(url));
  const retries = options.retryDelaysMs ?? defaultRetries;
  const url = (path: string) => new URL(path, options.baseUrl).toString();
  const listeners = new Set<() => void>();
  let state = initialAgent;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = true;
  const emit = (next: AgentState) => {
    state = next;

    for (const listener of [...listeners]) listener();
  };
  const setConnection = (connection: AgentState['connection']) => {
    if (state.connection !== connection) emit({ ...state, connection });
  };
  const close = () => {
    source?.close();
    source = null;

    if (retry) clearTimeout(retry);

    retry = null;
  };
  const reconnect = () => {
    close();

    if (stopped) return;

    setConnection('reconnecting');

    const delay = retries[Math.min(attempt, retries.length - 1)] ?? 30_000;

    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      open();
    }, delay);
  };
  const open = () => {
    if (stopped || source) return;

    const current = createEventSource(url('dev/agent/events'));

    source = current;
    current.onmessage = (message) => {
      if (source !== current) return;

      let event: AgentEvent | null;

      try {
        event = parseAgentEvent(JSON.parse(String(message.data)));
      } catch {
        event = null;
      }

      if (!event) return;

      attempt = 0;
      emit({ ...applyAgentEvent(state, event), connection: 'live' });
    };
    current.onerror = () => {
      if (source !== current) return;

      // EventSource retries dropped connections itself; a refused one is closed.
      if (current.readyState === 2) reconnect();
      else setConnection('reconnecting');
    };
  };
  const post = async (path: string, body: unknown): Promise<SendResult> => {
    let response: Response;

    try {
      response = await fetchImpl(url(path), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      return { ok: false, error: 'Could not reach relate dev' };
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (response.ok) {
      const turn = agentTurnAcceptedSchema.safeParse(payload);

      return turn.success
        ? { ok: true, turn: turn.data }
        : { ok: false, error: 'relate dev sent an unexpected reply' };
    }

    const failure = agentErrorSchema.safeParse(payload);

    return {
      ok: false,
      error: failure.success
        ? failure.data.error
        : `relate dev refused the request (${response.status})`,
    };
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      if (!stopped) return;

      stopped = false;
      attempt = 0;
      setConnection('connecting');
      open();
    },
    stop() {
      if (stopped) return;

      stopped = true;
      close();
      // Availability belongs to the server this session talked to; a
      // restarted relate dev may have a key the old one lacked, or not.
      emit({ ...state, connection: 'stopped', availability: null });
    },
    send: (principal, text) => post('dev/agent/turns', { principal, text }),
    cancel: (turnId) =>
      post(`dev/agent/turns/${encodeURIComponent(turnId)}/cancel`, {}),
  };
}
