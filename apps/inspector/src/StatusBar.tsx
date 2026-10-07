import { useInspectorState } from './inspector-context.js';
import type { ConnectionState } from './connection/store.js';

const connectionLabel: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  unauthorized: 'No session',
  stale: 'Stale',
};

export function StatusBar() {
  const state = useInspectorState();
  const manifest = state.model?.manifest;
  const update = state.lastUpdate;

  return (
    <header className="status-bar">
      <span className="status-title">Relate inspector</span>
      <span
        className={`status-connection status-${state.connection}`}
        role="status"
      >
        {connectionLabel[state.connection]}
      </span>
      {state.model ? (
        <>
          <span className="status-item" title={state.model.definitionRevision}>
            <strong>{manifest!.graphDefinitionId}</strong> · generation{' '}
            {state.model.generation}
          </span>
          <span className="status-item">
            {manifest!.objects.length} objects · {manifest!.sources.length}{' '}
            sources · {manifest!.relationships?.length ?? 0} relationships
          </span>
          {update && (
            <span className="status-item status-update">
              {summarizeDiff(update.diff)} · {Math.round(update.durationMs)}ms
            </span>
          )}
        </>
      ) : (
        <span className="status-item">No compiled model</span>
      )}
      {state.failure && (
        <span className="status-pill status-pill-error">
          attempt {state.failure.attempt} failed
        </span>
      )}
      {state.typecheck && state.typecheck.diagnostics.length > 0 && (
        <span className="status-pill status-pill-warning">
          {state.typecheck.diagnostics.length} type{' '}
          {state.typecheck.diagnostics.length === 1 ? 'error' : 'errors'}
        </span>
      )}
    </header>
  );
}

function summarizeDiff(diff: {
  objects: { added: string[]; changed: string[]; removed: string[] };
  relationships: { added: string[]; changed: string[]; removed: string[] };
  otherChanged: boolean;
}): string {
  const parts = [
    ...diff.objects.added.map((id) => `+${id}`),
    ...diff.relationships.added.map((id) => `+${id}`),
    ...diff.objects.changed.map((id) => `~${id}`),
    ...diff.relationships.changed.map((id) => `~${id}`),
    ...diff.objects.removed.map((id) => `-${id}`),
    ...diff.relationships.removed.map((id) => `-${id}`),
  ];

  if (parts.length === 0)
    return diff.otherChanged ? '~policies/sources/actions' : 'model unchanged';

  const shown = parts.slice(0, 3).join(' ');

  return parts.length > 3 ? `${shown} (+${parts.length - 3} changes)` : shown;
}
