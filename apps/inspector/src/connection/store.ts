/**
 * Client-side state for the development channel. Pure: no DOM, no fetch.
 *
 * Three states the UI must never blur: the authored code is invalid (a
 * `failure` with code diagnostics), the loader failed (a `failure` with a
 * `worker` diagnostic) and the connection dropped (`connection`, never a
 * diagnostic).
 */
import { assertFailureSeverity } from '../protocol.js';
import type {
  DevEvent,
  Diagnostic,
  ManifestDiff,
  ModelSnapshot,
} from '../protocol.js';

export type ConnectionState =
  'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'stale';

export type StaleReason = 'protocol' | 'session' | null;

export interface Failure {
  readonly attempt: number;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Typecheck {
  readonly revision: number;
  readonly diagnostics: readonly Diagnostic[];
}

export interface LastUpdate {
  readonly generation: number;
  readonly fromGeneration: number | null;
  readonly diff: ManifestDiff;
  readonly durationMs: number;
}

export interface InspectorState {
  readonly connection: ConnectionState;
  readonly staleReason: StaleReason;
  /** Protocol version an incompatible supervisor announced, if any. */
  readonly unsupportedProtocol: number | null;
  readonly instanceId: string | null;
  readonly sequence: number;
  readonly model: ModelSnapshot | null;
  readonly failure: Failure | null;
  readonly typecheck: Typecheck | null;
  readonly lastUpdate: LastUpdate | null;
  /** Layout problems are local presentation diagnostics, never compiler failures. */
  readonly layout: Diagnostic | null;
}

export const initialState: InspectorState = Object.freeze({
  connection: 'connecting',
  staleReason: null,
  unsupportedProtocol: null,
  instanceId: null,
  sequence: 0,
  model: null,
  failure: null,
  typecheck: null,
  lastUpdate: null,
  layout: null,
});

export type ApplyOutcome = 'applied' | 'duplicate' | 'gap' | 'ignored';

export interface ApplyResult {
  readonly state: InspectorState;
  readonly outcome: ApplyOutcome;
}

/** Apply one validated event. `gap` means the caller must resynchronize from a snapshot. */
export function applyEvent(
  state: InspectorState,
  event: DevEvent,
): ApplyResult {
  if (event.type === 'snapshot') {
    if (event.failure) assertFailureSeverity(event.failure.diagnostics);

    return {
      outcome: 'applied',
      state: {
        ...state,
        connection: 'live',
        staleReason: null,
        unsupportedProtocol: null,
        instanceId: event.instanceId,
        sequence: event.sequence,
        model: event.model,
        failure: event.failure,
        typecheck: event.typecheck ?? null,
        // A new instance has no update history; a resync of the same one keeps it.
        lastUpdate:
          state.instanceId === event.instanceId &&
          state.model?.generation === event.model?.generation
            ? state.lastUpdate
            : null,
      },
    };
  }

  if (state.instanceId === null || event.instanceId !== state.instanceId)
    return { state, outcome: 'gap' };

  if (event.sequence <= state.sequence) return { state, outcome: 'duplicate' };

  if (event.sequence !== state.sequence + 1) return { state, outcome: 'gap' };

  const advanced = {
    ...state,
    sequence: event.sequence,
    connection: 'live' as const,
  };

  switch (event.type) {
    case 'model': {
      // Late results from older attempts never replace a newer accepted model.
      if (state.model && event.model.generation <= state.model.generation)
        return { state: advanced, outcome: 'ignored' };

      return {
        outcome: 'applied',
        state: {
          ...advanced,
          model: event.model,
          // Success clears only the failed-attempt diagnostics, atomically.
          failure: null,
          lastUpdate: {
            generation: event.model.generation,
            fromGeneration: event.fromGeneration,
            diff: event.diff,
            durationMs: event.durationMs,
          },
        },
      };
    }
    case 'diagnostics': {
      assertFailureSeverity(event.diagnostics);

      if (state.failure && event.attempt < state.failure.attempt)
        return { state: advanced, outcome: 'ignored' };

      return {
        outcome: 'applied',
        state: {
          ...advanced,
          failure: { attempt: event.attempt, diagnostics: event.diagnostics },
        },
      };
    }
    case 'typecheck': {
      // Complete replacement per revision, independent of attempts and generations.
      if (state.typecheck && event.revision < state.typecheck.revision)
        return { state: advanced, outcome: 'ignored' };

      return {
        outcome: 'applied',
        state: {
          ...advanced,
          typecheck: {
            revision: event.revision,
            diagnostics: event.diagnostics,
          },
        },
      };
    }
  }
}

export function markConnection(
  state: InspectorState,
  connection: Exclude<ConnectionState, 'stale'>,
): InspectorState {
  return { ...state, connection, staleReason: null };
}

/** Keep the last graph visible but stop applying events. */
export function markStale(
  state: InspectorState,
  reason: Exclude<StaleReason, null>,
  unsupportedProtocol?: number,
): InspectorState {
  return {
    ...state,
    connection: 'stale',
    staleReason: reason,
    unsupportedProtocol:
      reason === 'protocol' ? (unsupportedProtocol ?? null) : null,
  };
}

export function setLayoutDiagnostic(
  state: InspectorState,
  layout: Diagnostic | null,
): InspectorState {
  return { ...state, layout };
}

/** Definition IDs a failed attempt names; only those present in the displayed graph are highlighted. */
export function failureDefinitionIds(
  failure: Failure | null,
): readonly string[] {
  if (!failure) return [];

  return [
    ...new Set(
      failure.diagnostics.flatMap((diagnostic) =>
        diagnostic.kind === 'compile' && diagnostic.definitionId
          ? [diagnostic.definitionId]
          : [],
      ),
    ),
  ];
}

/** What the failure means for the person reading it. */
export function failureOrigin(
  failure: Failure | null,
): 'code' | 'loader' | null {
  if (!failure) return null;

  return failure.diagnostics.some((d) => d.kind === 'worker') &&
    failure.diagnostics.every((d) => d.kind === 'worker')
    ? 'loader'
    : 'code';
}
