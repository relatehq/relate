/**
 * The activity log: a bounded, in-memory ring buffer of what MCP clients did
 * against the runtime. It lives in the dev server, so it survives runtime host
 * restarts; every event names the `runtimeId` it ran against.
 *
 * Events are upserts keyed by ID (`activityKey`): a `running` event is
 * replaced by its final version in place. An operation's runtime record,
 * forwarded by the runtime host, merges into the dispatch event with the same
 * operation ID, in either order (`mergeOperation`). Eviction is per transport
 * request, so a request's call, execution and operations leave together, and
 * only finished requests are evicted: late events of an evicted request are
 * dropped rather than starting an orphan entry.
 *
 * A runtime record may open an entry without a running start (a nested
 * refresh, a committed feed entry), but only within a request the log already
 * holds: runtime activity outside a dev request (a seed, earlier history in a
 * persistent store) is not shown.
 *
 * Every caller-controlled string is bounded where the event is built (see
 * `activityLimits`); `record` also enforces a per-event budget as a backstop.
 */
import {
  activityKey,
  activityRequestId,
  type ActivityEvent,
  type OperationEvent,
} from '@relate/inspector/protocol';

export const activityLimits = Object.freeze({
  /** Requests (each `discover` or `execute` call) kept, oldest evicted first. */
  requests: 200,
  /** Operations kept per request; later ones are not recorded. */
  operationsPerRequest: 500,
  /** UTF-16 code units of submitted code kept per execution. */
  code: 16 * 1024,
  /** Code units of captured stdout/stderr kept per execution. */
  logs: 16 * 1024,
  /** Code units of a result, filter, input or issues preview. */
  preview: 1024,
  /** Record IDs kept per operation. */
  recordIds: 100,
  /** Code units of an identifier, key, cursor or error code. */
  text: 256,
  /** Code units of one serialized event; larger events lose their details. */
  event: 64 * 1024,
  /** Evicted request IDs remembered, so their late events are dropped. */
  evicted: 1_000,
});

export type ActivityListener = (event: ActivityEvent) => void;

export interface ActivityLog {
  /** Insert or replace an event. A final event whose request was evicted is dropped. */
  record(event: ActivityEvent): void;
  /** Retained events in first-seen order. */
  snapshot(): ActivityEvent[];
  /** Snapshot and registration are atomic: no event falls between them. */
  subscribe(listener: ActivityListener): {
    readonly snapshot: ActivityEvent[];
    unsubscribe(): void;
  };
}

export function createActivityLog(
  limits: {
    readonly requests?: number;
    readonly operationsPerRequest?: number;
  } = {},
): ActivityLog {
  const maxRequests = limits.requests ?? activityLimits.requests;
  const maxOperations =
    limits.operationsPerRequest ?? activityLimits.operationsPerRequest;
  // Map order is insertion order, and replacing a value keeps its position.
  const events = new Map<string, ActivityEvent>();
  const requests = new Map<string, { keys: Set<string>; operations: number }>();
  const evicted = new Set<string>();
  const listeners = new Set<ActivityListener>();
  const running = (keys: Set<string>) =>
    [...keys].some((key) => events.get(key)?.status === 'running');
  /** Evict the oldest finished requests; a running one is never cut short. */
  const evict = () => {
    for (const [requestId, entry] of requests) {
      if (requests.size <= maxRequests) return;

      if (running(entry.keys)) continue;

      requests.delete(requestId);

      for (const key of entry.keys) events.delete(key);

      evicted.add(requestId);

      if (evicted.size > activityLimits.evicted)
        evicted.delete(evicted.values().next().value!);
    }
  };

  return {
    record(event) {
      const key = activityKey(event);
      const requestId = activityRequestId(event);

      const previous = events.get(key);

      if (!previous) {
        // Only a start opens an entry; the end of an evicted one stays evicted.
        // A runtime record joins a request the log already holds.
        if (
          evicted.has(requestId) ||
          (event.status !== 'running' &&
            !(
              event.kind === 'operation' &&
              event.runtime &&
              requests.has(requestId)
            ))
        )
          return;

        let request = requests.get(requestId);

        if (!request) {
          request = { keys: new Set(), operations: 0 };
          requests.set(requestId, request);
        }

        if (event.kind === 'operation') {
          if (request.operations >= maxOperations) return;

          request.operations += 1;
        }

        request.keys.add(key);
      }

      // Budget the merged event: both halves can be large on their own.
      const next = withinBudget(
        previous?.kind === 'operation' && event.kind === 'operation'
          ? mergeOperation(previous, event)
          : event,
      );

      events.set(key, next);
      evict();

      for (const listener of [...listeners]) listener(next);
    },
    snapshot: () => [...events.values()],
    subscribe(listener) {
      listeners.add(listener);

      return {
        snapshot: [...events.values()],
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
  };
}

/**
 * The dispatch event (request previews, the transport's answer) and the
 * runtime record (authoritative outcome, lineage) of one operation, whichever
 * arrives first. A later dispatch update never overrides the runtime's status.
 */
export function mergeOperation(
  previous: OperationEvent,
  next: OperationEvent,
): OperationEvent {
  const runtime = next.runtime ?? previous.runtime;
  const authoritative = next.runtime
    ? next
    : previous.runtime
      ? previous
      : next;
  const outcome = { ...previous.outcome, ...next.outcome };
  const ms = next.runtime ? (previous.ms ?? next.ms) : (next.ms ?? previous.ms);

  return {
    ...previous,
    ...next,
    at: previous.at,
    request: Object.keys(next.request).length ? next.request : previous.request,
    recordIds: next.recordIds.length ? next.recordIds : previous.recordIds,
    status: authoritative.status,
    ...(Object.keys(outcome).length ? { outcome } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

/**
 * Backstop for the per-event budget: an event over it keeps its identity,
 * status, operation outcome and runtime record but loses its request
 * details, code and logs.
 */
function withinBudget(event: ActivityEvent): ActivityEvent {
  if (JSON.stringify(event).length <= activityLimits.event) return event;

  switch (event.kind) {
    case 'call':
      return { ...event, error: truncate(event.error ?? '', 64).text };
    case 'execution': {
      const { resultPreview: _result, error: _error, ...rest } = event;

      return {
        ...rest,
        code: truncate(event.code, 1024).text,
        codeTruncated: true,
        logs: [],
        logsTruncated: true,
      };
    }
    case 'operation':
      return {
        ...event,
        request: {},
        recordIds: [],
        ...(event.runtime
          ? {
              runtime: {
                ...event.runtime,
                ...(event.runtime.forbidden
                  ? { forbidden: event.runtime.forbidden.slice(0, 50) }
                  : {}),
                ...(event.runtime.changedPropertyIds
                  ? {
                      changedPropertyIds:
                        event.runtime.changedPropertyIds.slice(0, 50),
                    }
                  : {}),
              },
            }
          : {}),
      };
  }
}

/** A bounded identifier, key or code. */
export function text(value: unknown): string {
  return truncate(String(value), activityLimits.text).text;
}

/** A bounded string: the head, then a marker saying how much was cut. */
export function truncate(
  text: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };

  return {
    text: `${text.slice(0, limit)}… (${text.length - limit} more characters)`,
    truncated: true,
  };
}

/** A bounded JSON preview of any value; never throws. */
export function preview(
  value: unknown,
  limit: number = activityLimits.preview,
): string {
  let text: string;

  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = '[unserializable]';
  }

  return truncate(text, limit).text;
}
