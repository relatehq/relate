import { canonicalJson } from 'relate/model';
import type { Acceptance, Observation } from '../storage.js';

export class OrderingConflict extends Error {
  constructor() {
    super('Conflicting observation ordering evidence');
    this.name = 'OrderingConflict';
  }
}

/** Preserves the prototype's source-version then fetch-start acceptance rule. */
export function compareObservation(
  previous: Observation | undefined,
  incoming: Observation,
): Acceptance {
  if (!previous) return 'changed';

  const same =
    canonicalJson({
      state: previous.state,
      raw: previous.raw,
      values: previous.values,
    }) ===
    canonicalJson({
      state: incoming.state,
      raw: incoming.raw,
      values: incoming.values,
    });
  const before = previous.version,
    after = incoming.version;

  if (
    !!before !== !!after ||
    (before && after && before.domain !== after.domain)
  )
    throw new OrderingConflict();

  if (before && after) {
    if (BigInt(after.value) < BigInt(before.value)) return 'superseded';

    if (BigInt(after.value) > BigInt(before.value))
      return same ? 'unchanged' : 'changed';

    if (!same) throw new OrderingConflict();
  }

  if (BigInt(incoming.token) < BigInt(previous.token)) return 'superseded';

  if (incoming.token === previous.token) {
    if (!same) throw new OrderingConflict();

    return 'replay';
  }

  return same ? 'unchanged' : 'changed';
}
