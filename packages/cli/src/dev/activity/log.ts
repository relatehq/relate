/**
 * The activity log: a bounded, in-memory ring buffer of what MCP clients did
 * against the runtime. It lives in the dev server, so it survives runtime host
 * restarts; every event names the `runtimeId` it ran against.
 *
 * Events are upserts keyed by ID (`activityKey`): a `running` event is
 * replaced by its final version in place. Eviction is per transport request,
 * so a request's call, execution and operations leave together.
 */
import {
  activityKey,
  activityRequestId,
  type ActivityEvent,
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
  const listeners = new Set<ActivityListener>();

  return {
    record(event) {
      const key = activityKey(event);
      const requestId = activityRequestId(event);

      if (!events.has(key)) {
        // Only a start opens an entry; the end of an evicted one stays evicted.
        if (event.status !== 'running') return;

        let request = requests.get(requestId);

        if (!request) {
          request = { keys: new Set(), operations: 0 };
          requests.set(requestId, request);

          while (requests.size > maxRequests) {
            const [oldest, entry] = requests.entries().next().value!;

            requests.delete(oldest);

            for (const evicted of entry.keys) events.delete(evicted);
          }
        }

        if (event.kind === 'operation') {
          if (request.operations >= maxOperations) return;

          request.operations += 1;
        }

        request.keys.add(key);
      }

      events.set(key, event);

      for (const listener of [...listeners]) listener(event);
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
