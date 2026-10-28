import { canonicalJson } from 'relate/model';
import type {
  Acceptance,
  AcceptedChange,
  Observation,
  StoredObject,
  TransactionalAcceptInput,
  TransactionalAcceptance,
} from '../storage.js';
import { describeAcceptedChange } from './changes.js';

export class OrderingConflict extends Error {
  constructor() {
    super('Conflicting observation ordering evidence');
    this.name = 'OrderingConflict';
  }
}

/**
 * An action adoption can no longer commit as validated: the identity was
 * adopted with another ID, or a newer, different observation was committed.
 * The whole action rolls back; a retry with the same key reruns the handler.
 */
export class AdoptionConflict extends Error {
  constructor(options?: ErrorOptions) {
    super('Action adoption conflicts with committed source state', options);
    this.name = 'AdoptionConflict';
  }
}

/**
 * Whether two observations show identical state, raw fields and mapped values,
 * regardless of when they were fetched. Transactional adoption commits a newer
 * committed observation with the same view instead of aborting.
 */
export function sameView(a: Observation, b: Observation): boolean {
  return (
    canonicalJson({ state: a.state, raw: a.raw, values: a.values }) ===
    canonicalJson({ state: b.state, raw: b.raw, values: b.values })
  );
}

/** Preserves the prototype's source-version then fetch-start acceptance rule. */
export function compareObservation(
  previous: Observation | undefined,
  incoming: Observation,
): Acceptance {
  if (!previous) return 'changed';

  const same = sameView(previous, incoming);
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

/**
 * The decision of one transactional adoption against the locked committed
 * identity, shared by every adapter. `write` is false when the committed
 * observation already wins with the same view; nothing is retained then.
 */
export interface TransactionalDecision {
  readonly object: StoredObject;
  readonly acceptance: TransactionalAcceptance['acceptance'];
  readonly write: boolean;
  readonly transition?: Omit<AcceptedChange, 'id'>;
}

/**
 * Decide a transactional adoption. Rejects a different committed ID, conflicting
 * ordering evidence, and a newer committed observation that is not the same
 * view with `AdoptionConflict`; never returns `superseded`.
 */
export function decideTransactionalAcceptance(
  previous: StoredObject | undefined,
  input: TransactionalAcceptInput,
): TransactionalDecision {
  if (input.observation.state !== 'present' || input.adopt !== true)
    throw new Error('Only present observations may be adopted');

  if (previous && previous.objectId !== input.objectId)
    throw new AdoptionConflict();

  let acceptance;

  try {
    acceptance = compareObservation(previous?.observation, input.observation);
  } catch (error) {
    if (error instanceof OrderingConflict)
      throw new AdoptionConflict({ cause: error });

    throw error;
  }

  if (acceptance === 'superseded') {
    // A newer committed observation is safe only when it shows the view the
    // action validated; any other change must not produce a success receipt.
    if (!sameView(previous!.observation, input.observation))
      throw new AdoptionConflict();

    return { object: previous!, acceptance: 'unchanged', write: false };
  }

  if (acceptance === 'replay')
    return { object: previous!, acceptance, write: false };

  const transition = describeAcceptedChange(
    previous?.observation,
    input.observation,
  );

  return {
    object: {
      objectId: input.objectId,
      sourceRecordId: input.sourceRecordId,
      observation: input.observation,
    },
    acceptance,
    write: true,
    ...(transition ? { transition } : {}),
  };
}
