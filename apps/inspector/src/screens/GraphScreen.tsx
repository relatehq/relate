import { useMemo, useState } from 'react';
import { DiagnosticsPanel } from '../diagnostics/DiagnosticsPanel.js';
import { ModelGraph } from '../graph/ModelGraph.js';
import { highlightable, mapManifest } from '../graph/map.js';
import { failureDefinitionIds } from '../connection/store.js';
import { useInspectorState } from '../inspector-context.js';

export function GraphScreen() {
  const state = useInspectorState();
  const model = useMemo(
    () => (state.model ? mapManifest(state.model.manifest) : null),
    [state.model],
  );
  const highlights = useMemo(
    () => highlightable(model, failureDefinitionIds(state.failure)),
    [model, state.failure],
  );
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="graph-screen">
      <ModelGraph
        model={model}
        generation={state.model?.generation ?? 0}
        highlights={highlights}
        selected={selected}
        onSelect={setSelected}
      />
      <DiagnosticsPanel
        failure={state.failure}
        typecheck={state.typecheck}
        layout={state.layout}
        displayedGeneration={state.model?.generation ?? null}
        highlights={highlights}
        onSelect={setSelected}
      />
    </div>
  );
}
