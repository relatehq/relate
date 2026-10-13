/**
 * `GET /dev/activity`: the activity snapshot as JSON, or, for
 * `Accept: text/event-stream`, a stream that opens with the snapshot and then
 * sends each event as it is recorded. Session-guarded by the dev server, and
 * separate from `/dev/events` so model generations and sequences keep their
 * meaning.
 */
import type { Context } from 'hono';
import type { ActivityMessage } from '@relate/inspector/protocol';
import { streamJson, type SseStreams } from '../sse.js';
import type { ActivityLog } from './log.js';

export function activityRoute(options: {
  readonly log: ActivityLog;
  readonly streams: SseStreams;
  readonly heartbeatMs: number;
}): (c: Context) => Response {
  return (c) => {
    if (!(c.req.header('accept') ?? '').includes('text/event-stream'))
      return c.json(
        {
          type: 'snapshot',
          events: options.log.snapshot(),
        } satisfies ActivityMessage,
        200,
        { 'Cache-Control': 'no-store' },
      );

    return streamJson<ActivityMessage>(c, {
      streams: options.streams,
      heartbeatMs: options.heartbeatMs,
      subscribe(send) {
        const subscription = options.log.subscribe((event) =>
          send({ type: 'event', event }),
        );

        return {
          initial: { type: 'snapshot', events: subscription.snapshot },
          unsubscribe: subscription.unsubscribe,
        };
      },
    });
  };
}
