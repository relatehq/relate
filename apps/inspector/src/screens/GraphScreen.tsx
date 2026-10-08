import { useMemo, useState } from 'react';
import { ModelGraph } from '../graph/ModelGraph.js';
import { highlightable, mapManifest } from '../graph/map.js';
import { SidePanel, panelNeeded } from '../panel/SidePanel.js';
import { useDevClient, useInspectorState } from '../inspector-context.js';
import { Callout } from '../ui.js';

export function GraphScreen() {
  const state = useInspectorState();
  const client = useDevClient();
  const model = useMemo(
    () => (state.model ? mapManifest(state.model.manifest) : null),
    [state.model],
  );
  const highlights = useMemo(() => {
    const counts = new Map<string, number>();

    for (const diagnostic of state.failure?.diagnostics ?? [])
      if (diagnostic.kind === 'compile' && diagnostic.definitionId)
        counts.set(
          diagnostic.definitionId,
          (counts.get(diagnostic.definitionId) ?? 0) + 1,
        );

    const present = highlightable(model, [...counts.keys()]);

    return {
      nodes: new Map(
        [...present.nodes].map((id) => [id, counts.get(id) ?? 0] as const),
      ),
      edges: present.edges,
    };
  }, [model, state.failure]);
  const [selected, setSelected] = useState<string | null>(null);
  const showPanel = panelNeeded(state, selected);
  const stale =
    state.connection === 'reconnecting' || state.connection === 'stale';
  const generation = state.model?.generation ?? null;

  return (
    <div className="graph-screen">
      <div className={`graph-area${showPanel ? ' with-panel' : ''}`}>
        <ModelGraph
          model={model}
          generation={generation ?? 0}
          highlights={highlights}
          selected={selected}
          onSelect={setSelected}
        />
        {!state.model && state.connection !== 'connecting' && (
          <div className="graph-overlay-center initial">
            <div className="title">No model yet</div>
            <div className="hint">
              {state.failure
                ? `Attempt ${state.failure.attempt} failed before a model was published. Fix the problem and save to load the graph.`
                : 'Waiting for the first compiled model from relate dev.'}
            </div>
          </div>
        )}
        {model && model.nodes.length === 0 && (
          <div className="graph-overlay-center empty">
            <div className="title">This graph has no objects</div>
            <div className="hint">
              {state.model!.manifest.graphDefinitionId} compiled with 0 objects
              and 0 relationships. Objects appear here when you add them to
              defineGraph and save.
            </div>
            <div className="snippet">
              {`defineGraph({ id: '${state.model!.manifest.graphDefinitionId}', objects: { } })`}
            </div>
          </div>
        )}
        {stale && <div className="stale-overlay" aria-hidden="true" />}
        {state.connection === 'reconnecting' && (
          <div className="graph-callout">
            <Callout
              variant="warning"
              title="Lost connection to relate dev"
              description={`Reconnecting. The graph shows ${
                generation === null ? 'no model' : `gen ${generation}`
              } and may be out of date.`}
            />
          </div>
        )}
        {state.connection === 'stale' && state.staleReason === 'protocol' && (
          <div className="graph-callout">
            <Callout
              variant="info"
              title="Inspector updated — reload to continue"
              description={`This tab runs an older inspector version (the server speaks protocol ${state.unsupportedProtocol}). The graph below is ${
                generation === null ? 'empty' : `gen ${generation}`
              } and stops updating until you reload.`}
              action={{
                label: 'Reload',
                onClick: () => window.location.reload(),
              }}
            />
          </div>
        )}
        {state.connection === 'stale' && state.staleReason === 'session' && (
          <div className="graph-callout">
            <Callout
              variant="info"
              title="Session ended"
              description="relate dev restarted and this session is no longer valid. Open the new link printed in the terminal; the graph below is kept as a stale copy."
              action={{ label: 'Retry', onClick: () => void client.resync() }}
            />
          </div>
        )}
      </div>
      {showPanel && (
        <SidePanel
          state={state}
          model={model}
          selected={selected}
          highlights={highlights}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
