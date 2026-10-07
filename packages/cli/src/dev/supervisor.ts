/**
 * The common model/failure state both the terminal and the SSE adapter consume.
 * Successful attempts advance the generation; failed attempts never do.
 */
import { randomUUID } from 'node:crypto';
import type { Manifest } from 'relate/model';
import {
  PROTOCOL_VERSION,
  type DevEvent,
  type Diagnostic,
  type DiagnosticsEvent,
  type ModelEvent,
  type ModelSnapshot,
  type SnapshotEvent,
} from '@relate/inspector/protocol';
import { diffManifests } from './diff.js';

export interface Failure {
  readonly attempt: number;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SupervisorState {
  readonly instanceId: string;
  readonly sequence: number;
  readonly generation: number;
  readonly model: ModelSnapshot | null;
  readonly failure: Failure | null;
}

export type Listener = (event: DevEvent) => void;

export interface Subscription {
  /** Captured atomically with the registration: no update can fall between them. */
  readonly snapshot: SnapshotEvent;
  unsubscribe(): void;
}

export class Supervisor {
  private readonly listeners = new Set<Listener>();
  private current: SupervisorState;

  constructor(instanceId: string = randomUUID()) {
    this.current = {
      instanceId,
      sequence: 0,
      generation: 0,
      model: null,
      failure: null,
    };
  }

  get state(): SupervisorState {
    return this.current;
  }

  snapshot(): SnapshotEvent {
    return {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.current.instanceId,
      sequence: this.current.sequence,
      type: 'snapshot',
      model: this.current.model,
      failure: this.current.failure,
    };
  }

  subscribe(listener: Listener): Subscription {
    this.listeners.add(listener);

    return {
      snapshot: this.snapshot(),
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Publish a newer accepted model. Returns the event and the manifest it replaced. */
  acceptModel(
    model: { readonly manifest: Manifest; readonly definitionRevision: string },
    durationMs: number,
  ): { readonly event: ModelEvent; readonly previous: Manifest | null } {
    const previous = this.current.model;
    const snapshot: ModelSnapshot = {
      generation: this.current.generation + 1,
      definitionRevision: model.definitionRevision,
      manifest: model.manifest,
    };
    const event: ModelEvent = {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.current.instanceId,
      sequence: this.current.sequence + 1,
      type: 'model',
      model: snapshot,
      fromGeneration: previous?.generation ?? null,
      diff: diffManifests(previous?.manifest ?? null, model.manifest),
      durationMs,
    };

    this.current = {
      ...this.current,
      sequence: event.sequence,
      generation: snapshot.generation,
      model: snapshot,
      // Success clears only the failed-attempt diagnostics.
      failure: null,
    };
    this.emit(event);

    return { event, previous: previous?.manifest ?? null };
  }

  acceptFailure(
    attempt: number,
    diagnostics: readonly Diagnostic[],
  ): DiagnosticsEvent {
    const event: DiagnosticsEvent = {
      protocolVersion: PROTOCOL_VERSION,
      instanceId: this.current.instanceId,
      sequence: this.current.sequence + 1,
      type: 'diagnostics',
      attempt,
      diagnostics,
    };

    this.current = {
      ...this.current,
      sequence: event.sequence,
      failure: { attempt, diagnostics },
    };
    this.emit(event);

    return event;
  }

  private emit(event: DevEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
