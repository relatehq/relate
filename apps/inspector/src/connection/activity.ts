/**
 * The activity timeline in the browser: a separate stream from the model
 * channel (`GET /dev/activity`). It opens with a snapshot, then sends each
 * event as it is recorded; events are upserts, so a reconnect simply replaces
 * the buffer with the new snapshot. No sequences: nothing here is ordered
 * against the model.
 *
 * Events land in a Map-indexed buffer (constant time per event) and the
 * visible state is published at most every `PUBLISH_MS`, so a busy execution
 * does not rebuild the list once per operation.
 */
import {
  activityEventSchema,
  activityKey,
  activityRequestId,
} from '../protocol.js';
import type {
  ActivityEvent,
  CallEvent,
  ExecutionEvent,
  OperationEvent,
} from '../protocol.js';
import type { DevClient } from './client.js';

/** Mirrors the dev server's ring buffer, so a long-lived tab stays bounded. */
export const ACTIVITY_REQUEST_LIMIT = 200;

/** How long an object stays highlighted after an operation touches it. */
export const TOUCH_MS = 2_500;

/** Longest delay between an event arriving and the screen showing it. */
export const PUBLISH_MS = 50;

export interface ActivityState {
  /** `stopped`: no inspector session, so no stream is open. */
  readonly connection: 'stopped' | 'connecting' | 'live' | 'reconnecting';
  /** First-seen order; later versions replace earlier ones in place. */
  readonly events: readonly ActivityEvent[];
  /**
   * Object definition IDs live operations touched, with the browser time
   * they did. Snapshots do not touch anything: only what happens now glows.
   */
  readonly touched: ReadonlyMap<string, number>;
}

export const initialActivity: ActivityState = Object.freeze({
  connection: 'stopped',
  events: [],
  touched: new Map(),
});

/** Insertion-ordered events indexed by key, evicted per request. */
export class ActivityBuffer {
  private readonly events = new Map<string, ActivityEvent>();
  private readonly requests = new Map<string, Set<string>>();
  private readonly touchedAt = new Map<string, number>();

  constructor(private readonly limit: number = ACTIVITY_REQUEST_LIMIT) {}

  replace(events: readonly ActivityEvent[]): void {
    this.events.clear();
    this.requests.clear();

    for (const event of events) this.upsert(event);
  }

  /** Constant time apart from evicting one request's events. */
  upsert(event: ActivityEvent, touchedAt?: number): void {
    const key = activityKey(event);

    if (!this.events.has(key)) {
      const requestId = activityRequestId(event);
      let keys = this.requests.get(requestId);

      if (!keys) {
        keys = new Set();
        this.requests.set(requestId, keys);

        if (this.requests.size > this.limit) {
          const [oldest, evicted] = this.requests.entries().next().value!;

          this.requests.delete(oldest);

          for (const gone of evicted) this.events.delete(gone);
        }
      }

      keys.add(key);
    }

    this.events.set(key, event);

    if (touchedAt !== undefined && event.kind === 'operation')
      this.touchedAt.set(event.definitionId, touchedAt);
  }

  list(): ActivityEvent[] {
    return [...this.events.values()];
  }

  /** Recent touches; older ones are forgotten so the map stays small. */
  touched(now: number): ReadonlyMap<string, number> {
    for (const [definitionId, at] of this.touchedAt)
      if (now - at >= TOUCH_MS) this.touchedAt.delete(definitionId);

    return new Map(this.touchedAt);
  }
}

/**
 * Validate one stream payload. Events are checked one by one: an event this
 * inspector cannot read is skipped instead of discarding the whole snapshot,
 * so it can never trap the stream in a reconnect loop.
 */
export function parseActivityMessage(
  input: unknown,
):
  | { readonly type: 'snapshot'; readonly events: ActivityEvent[] }
  | { readonly type: 'event'; readonly event: ActivityEvent | null }
  | null {
  const message = input as {
    type?: unknown;
    events?: unknown;
    event?: unknown;
  };

  if (message?.type === 'snapshot' && Array.isArray(message.events))
    return {
      type: 'snapshot',
      events: message.events.flatMap((event) => {
        const parsed = activityEventSchema.safeParse(event);

        return parsed.success ? [parsed.data] : [];
      }),
    };

  if (message?.type === 'event') {
    const parsed = activityEventSchema.safeParse(message.event);

    return { type: 'event', event: parsed.success ? parsed.data : null };
  }

  return null;
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
  /** Open the stream; idempotent. */
  start(): void;
  /** Close the stream and stop retrying; idempotent. */
  stop(): void;
}

const defaultRetries = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export function createActivityClient(options: {
  readonly baseUrl: URL;
  readonly createEventSource?: (url: string) => EventSource;
  readonly retryDelaysMs?: readonly number[];
  readonly now?: () => number;
}): ActivityClient {
  const createEventSource =
    options.createEventSource ?? ((url) => new EventSource(url));
  const retries = options.retryDelaysMs ?? defaultRetries;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const buffer = new ActivityBuffer();
  let state = initialActivity;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let publishing: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let stopped = true;
  const emit = (next: ActivityState) => {
    state = next;

    for (const listener of [...listeners]) listener();
  };
  const setConnection = (connection: ActivityState['connection']) => {
    if (state.connection !== connection) emit({ ...state, connection });
  };
  const publish = () => {
    publishing = null;
    emit({
      ...state,
      connection: 'live',
      events: buffer.list(),
      touched: buffer.touched(now()),
    });
  };
  const schedule = () => {
    publishing ??= setTimeout(publish, PUBLISH_MS);
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

    const current = createEventSource(
      new URL('dev/activity', options.baseUrl).toString(),
    );

    source = current;
    current.onmessage = (message) => {
      if (source !== current) return;

      let parsed: ReturnType<typeof parseActivityMessage>;

      try {
        parsed = parseActivityMessage(JSON.parse(String(message.data)));
      } catch {
        parsed = null;
      }

      if (!parsed) return;

      attempt = 0;

      if (parsed.type === 'snapshot') buffer.replace(parsed.events);
      else if (parsed.event) buffer.upsert(parsed.event, now());

      schedule();
    };
    current.onerror = () => {
      if (source !== current) return;

      // EventSource retries dropped connections itself; a refused one is closed.
      if (current.readyState === 2) reconnect();
      else setConnection('reconnecting');
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
      setConnection('stopped');
    },
  };
}

/**
 * Run the activity stream only while the inspector has a live session: it
 * starts once the dev client is live, and stops when the session is refused
 * or lost (the dev server restarted), instead of retrying a 401 forever.
 */
export function followSession(
  dev: Pick<DevClient, 'getState' | 'subscribe'>,
  activity: Pick<ActivityClient, 'start' | 'stop'>,
): () => void {
  const sync = () => {
    const { connection } = dev.getState();

    if (connection === 'live') activity.start();
    else if (connection === 'unauthorized' || connection === 'stale')
      activity.stop();
  };

  sync();

  return dev.subscribe(sync);
}
