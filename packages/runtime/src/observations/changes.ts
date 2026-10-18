import type { Change } from '@relate/protocol';
import type { Observation } from 'relate/storage';
import { canonicalJson } from 'relate/model';

/** Compare accepted business state under the adapter's acceptance lock. */
export function describeAcceptedChange(
  previous: Observation | undefined,
  accepted: Observation,
):
  | {
      kind: Exclude<Change['kind'], 'created'>;
      changedPropertyIds: readonly string[];
    }
  | undefined {
  if (!previous)
    return {
      kind: 'adopted',
      changedPropertyIds: Object.keys(accepted.values).sort(),
    };

  if (previous.state !== accepted.state)
    return {
      kind: accepted.state === 'deleted' ? 'deleted' : 'restored',
      changedPropertyIds: [],
    };

  const changedPropertyIds = [
    ...new Set([
      ...Object.keys(previous.values),
      ...Object.keys(accepted.values),
    ]),
  ]
    .filter(
      (id) =>
        Object.hasOwn(previous.values, id) !==
          Object.hasOwn(accepted.values, id) ||
        (Object.hasOwn(previous.values, id) &&
          canonicalJson(previous.values[id]!) !==
            canonicalJson(accepted.values[id]!)),
    )
    .sort();

  return changedPropertyIds.length
    ? { kind: 'updated', changedPropertyIds }
    : undefined;
}
