import { canonicalJson } from 'relate/model';
import type { AcceptedChange, Observation } from '../storage.js';

const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * The business-state transition of one winning acceptance, or undefined when
 * mapped values and state are unchanged. Raw provider fields and observation
 * freshness never produce a change. Adapters call this under their acceptance
 * lock with the locked previous observation, only for `changed` or `unchanged`
 * acceptances.
 */
export function describeAcceptedChange(
  previous: Observation | undefined,
  accepted: Observation,
): Omit<AcceptedChange, 'id'> | undefined {
  if (!previous)
    return {
      kind: 'adopted',
      changedPropertyIds: sorted(Object.keys(accepted.values)),
    };

  if (previous.state !== accepted.state)
    return {
      kind: accepted.state === 'deleted' ? 'deleted' : 'restored',
      changedPropertyIds: [],
    };

  if (accepted.state === 'deleted') return undefined;

  const changedPropertyIds = sorted([
    ...Object.keys(previous.values),
    ...Object.keys(accepted.values),
  ]).filter(
    (id) =>
      Object.hasOwn(previous.values, id) !==
        Object.hasOwn(accepted.values, id) ||
      canonicalJson(previous.values[id] ?? null) !==
        canonicalJson(accepted.values[id] ?? null),
  );

  return changedPropertyIds.length
    ? { kind: 'updated', changedPropertyIds }
    : undefined;
}
