/**
 * The activity timeline in the browser: a separate stream from the model
 * channel (`GET /dev/activity`). It opens with a snapshot, then sends each
 * event as it is recorded; events are upserts, so a reconnect simply replaces
 * the state with the new snapshot. No sequences: nothing here is ordered
 * against the model.
 */
import {
  activityKey,
  activityMessageSchema,
  activityRequestId,
} from '../protocol.js';
import type {
  ActivityEvent,
  ActivityMessage,
  CallEvent,
  ExecutionEvent,
  OperationEvent,
} from '../protocol.js';

/** Mirrors the dev server's ring buffer, so a long-lived tab stays bounded. */
export const ACTIVITY_REQUEST_LIMIT = 200;

/** How long an object stays highlighted after an operation touches it. */
export const TOUCH_MS = 2_500;

export interface ActivityState {
  readonly connection: 'connecting' | 'live' | 'reconnecting';
  /** First-seen order; later versions replace earlier ones in place. */
  readonly events: readonly ActivityEvent[];
  /**
   * Object definition IDs live operations touched, with the browser time
   * they did. Snapshots do not touch anything: only what happens now glows.
   */
  readonly touched: ReadonlyMap<string, number>;
}

export const initialActivity: ActivityState = Object.freeze({
  connection: 'connecting',
  events: [],
  touched: new Map(),
});

function bounded(events: readonly ActivityEvent[]): readonly ActivityEvent[] {
  const requests = [...new Set(events.map(activityRequestId))];

  if (requests.length <= ACTIVITY_REQUEST_LIMIT) return events;

  const kept = new Set(requests.slice(-ACTIVITY_REQUEST_LIMIT));

  return events.filter((event) => kept.has(activityRequestId(event)));
}

export function applyActivity(
  state: ActivityState,
  message: ActivityMessage,
  now: number = Date.now(),
): ActivityState {
  if (message.type === 'snapshot')
    return {
      ...state,
      connection: 'live',
      events: bounded(message.events),
    };

  const { event } = message;
  const key = activityKey(event);
  const index = state.events.findIndex(
    (existing) => activityKey(existing) === key,
  );
  const events =
    index === -1
      ? bounded([...state.events, event])
      : state.events.map((existing, i) => (i === index ? event : existing));
  const touched =
    event.kind === 'operation'
      ? new Map(state.touched).set(event.definitionId, now)
      : state.touched;

  return { ...state, connection: 'live', events, touched };
}

/** Definition IDs touched within the last `TOUCH_MS`. */
export function touchedDefinitions(
  state: ActivityState,
  now: number = Date.now(),
): ReadonlySet<string> {
  return new Set(
    [...state.touched]
      .filter(([, at]) => now - at < TOUCH_MS)
      .map(([definitionId]) => definitionId),
  );
}

/** One transport request: its call, the code it ran and every operation behind it. */
export interface RequestActivity {
  readonly requestId: string;
  /** Absent for operations from a transport without tool calls (a future `/api`). */
  readonly call: CallEvent | undefined;
  readonly execution: ExecutionEvent | undefined;
  readonly operations: readonly OperationEvent[];
}

/** Requests newest first; operations in the order they started. */
export function groupActivity(
  events: readonly ActivityEvent[],
): readonly RequestActivity[] {
  const requests = new Map<
    string,
    {
      call?: CallEvent;
      execution?: ExecutionEvent;
      operations: OperationEvent[];
    }
  >();

  for (const event of events) {
    const requestId = activityRequestId(event);
    let entry = requests.get(requestId);

    if (!entry) {
      entry = { operations: [] };
      requests.set(requestId, entry);
    }

    if (event.kind === 'call') entry.call = event;
    else if (event.kind === 'execution') entry.execution = event;
    else entry.operations.push(event);
  }

  return [...requests]
    .map(([requestId, entry]) => ({
      requestId,
      call: entry.call,
      execution: entry.execution,
      operations: entry.operations,
    }))
    .reverse();
}

export interface ActivityClient {
  readonly getState: () => ActivityState;
  readonly subscribe: (listener: () => void) => () => void;
  start(): void;
  stop(): void;
}

export function createActivityClient(options: {
  readonly baseUrl: URL;
  readonly createEventSource?: (url: string) => EventSource;
  readonly retryMs?: number;
}): ActivityClient {
  const createEventSource =
    options.createEventSource ?? ((url) => new EventSource(url));
  const listeners = new Set<() => void>();
  let state = initialActivity;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  const update = (next: ActivityState) => {
    if (next === state) return;

    state = next;

    for (const listener of [...listeners]) listener();
  };
  const open = () => {
    if (stopped || source) return;

    const current = createEventSource(
      new URL('dev/activity', options.baseUrl).toString(),
    );

    source = current;
    current.onmessage = (message) => {
      if (source !== current) return;

      try {
        const parsed = activityMessageSchema.parse(
          JSON.parse(String(message.data)),
        );

        update(applyActivity(state, parsed));
      } catch {
        // A payload this inspector cannot read: start over from a snapshot.
        reconnect();
      }
    };
    current.onerror = () => {
      if (source !== current) return;

      // EventSource retries dropped connections itself; a refused one is closed.
      if (current.readyState === 2) reconnect();
      else update({ ...state, connection: 'reconnecting' });
    };
  };
  const reconnect = () => {
    source?.close();
    source = null;
    update({ ...state, connection: 'reconnecting' });

    if (stopped || retry) return;

    retry = setTimeout(() => {
      retry = null;
      open();
    }, options.retryMs ?? 5_000);
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
      stopped = false;
      open();
    },
    stop() {
      stopped = true;
      source?.close();
      source = null;

      if (retry) clearTimeout(retry);

      retry = null;
    },
  };
}
