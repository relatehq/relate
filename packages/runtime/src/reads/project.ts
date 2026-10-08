import { ReadError } from '@relate/protocol';
import type { ReadResult, ReadRequest, ObjectRecord } from '@relate/protocol';
import { summarize, supplied } from './evidence.js';

type Available = Extract<ReadResult, { status: 'ok' }>;

export function project(
  id: string,
  result: Available,
  selected: readonly string[],
  request: ReadRequest,
  now: number,
): ObjectRecord {
  const data: ObjectRecord['data'] = {};
  const fields: ObjectRecord['meta']['fields'] = {};

  for (const name of selected) {
    let evidence = result.meta.fields[name] ?? {
      status: 'unavailable' as const,
    };

    if (supplied(evidence) && evidence.source === 'source') {
      const age = now - Date.parse(evidence.observedAt);
      const stale = age < 0 || age > (request.maxAgeMs ?? 60_000);

      evidence =
        stale && request.stale === 'omit'
          ? { status: 'unavailable' }
          : { ...evidence, freshness: stale ? 'stale' : 'fresh' };
    }

    fields[name] = evidence;

    if (supplied(evidence) && Object.hasOwn(result.data, name))
      data[name] = result.data[name]!;
  }

  const summary = summarize(fields);

  if (summary.completeness === 'partial' && request.requireComplete)
    throw new ReadError('incomplete');

  return {
    id,
    data,
    meta: {
      ...result.meta,
      fields,
      completeness: summary.completeness,
      degraded: result.meta.degraded || summary.degraded,
    },
  };
}
