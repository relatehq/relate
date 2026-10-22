import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react';
import type { Edge, EdgeChange, Node, NodeChange } from '@xyflow/react';
import { ModelNode } from './ModelNode.js';
import { ArrowMarkers, ModelEdge } from './ModelEdge.js';
import { DockContext } from './DatasetDock.js';
import { dockDatasets, estimateNodeSize, layoutSignature } from './map.js';
import type {
  DockedDataset,
  GraphModel,
  GraphNodeData,
  GraphEdgeData,
} from './map.js';
import { useLayout } from '../layout/useLayout.js';
import type { LayoutRequest } from '../layout/elk.js';
import { useDevClient } from '../inspector-context.js';
import { useTheme } from '../theme/theme.js';
import { Button } from '../ui/button.js';

export type ModelFlowNode = Node<
  GraphNodeData & {
    issues: number;
    touched: boolean;
    docked: readonly DockedDataset[];
  },
  'object'
>;

export type ModelFlowEdge = Edge<
  GraphEdgeData & { highlighted: boolean },
  'relationship'
>;

const nodeTypes = { object: ModelNode };
const edgeTypes = { relationship: ModelEdge };

export interface ModelGraphProps {
  readonly model: GraphModel | null;
  readonly generation: number;
  /** Issue counts by definition ID for nodes, and highlighted edge IDs. */
  readonly highlights: {
    readonly nodes: ReadonlyMap<string, number>;
    readonly edges: ReadonlySet<string>;
  };
  /** Object definition IDs a graph operation touched just now. */
  readonly touched?: ReadonlySet<string>;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
}

export function ModelGraph(props: ModelGraphProps) {
  return (
    <ReactFlowProvider>
      <ModelGraphView {...props} />
    </ReactFlowProvider>
  );
}

function ModelGraphView(props: ModelGraphProps) {
  const { model, generation, highlights, touched, selected, onSelect } = props;
  const client = useDevClient();
  const flow = useReactFlow();
  const { theme } = useTheme();
  // What the canvas draws: associated datasets dock under their objects.
  const view = useMemo(() => (model ? dockDatasets(model) : null), [model]);
  const signature = useMemo(() => (view ? layoutSignature(view) : ''), [view]);
  const request = useMemo<LayoutRequest | null>(
    () =>
      view
        ? {
            generation,
            nodes: view.nodes.map((node) => ({
              id: node.id,
              ...estimateNodeSize(node.data),
            })),
            edges: view.edges.map((edge) => ({
              id: edge.id,
              source: edge.source,
              target: edge.target,
            })),
          }
        : null,
    [view, generation],
  );
  const layout = useLayout(request, signature);
  const previous = useRef<Map<string, { x: number; y: number }>>(new Map());
  const fitted = useRef(false);

  useEffect(() => {
    client.setLayoutDiagnostic(layout.diagnostic);
  }, [client, layout.diagnostic]);

  // Clear the selection only when its definition disappears.
  useEffect(() => {
    if (
      selected &&
      model &&
      !model.nodes.some((n) => n.id === selected) &&
      !model.edges.some((e) => e.id === selected)
    )
      onSelect(null);
  }, [model, selected, onSelect]);

  const nodes = useMemo<ModelFlowNode[]>(() => {
    if (!view) return [];

    return view.nodes.map((node) => {
      const size = estimateNodeSize(node.data);
      const position = layout.positions[node.id] ??
        previous.current.get(node.id) ?? { x: 0, y: 0 };

      previous.current.set(node.id, position);

      return {
        id: node.id,
        type: 'object',
        position,
        width: size.width,
        height: size.height,
        // Nodes are fixed-size and rebuilt on every render, so React Flow's own
        // measurement never reaches them; without this the graph is never
        // "initialized" and the first fit never runs.
        measured: size,
        draggable: false,
        connectable: false,
        deletable: false,
        selected: selected === node.id,
        data: {
          ...node.data,
          issues: highlights.nodes.get(node.id) ?? 0,
          touched: touched?.has(node.id) ?? false,
          docked: view.docks.get(node.id) ?? [],
        },
      };
    });
  }, [view, layout.positions, selected, highlights.nodes, touched]);
  const edges = useMemo<ModelFlowEdge[]>(
    () =>
      (view?.edges ?? []).map((edge) => ({
        id: edge.id,
        type: 'relationship',
        source: edge.source,
        target: edge.target,
        deletable: false,
        reconnectable: false,
        selected: selected === edge.id,
        data: { ...edge.data, highlighted: highlights.edges.has(edge.id) },
      })),
    [view, selected, highlights.edges],
  );
  const dock = useMemo(
    () => ({ selected, issues: highlights.nodes, onSelect }),
    [selected, highlights.nodes, onSelect],
  );
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);

    update();
    media.addEventListener('change', update);

    return () => media.removeEventListener('change', update);
  }, []);

  const duration = reducedMotion ? 0 : 250;
  const initialized = useNodesInitialized();

  // Fit once, on the first non-empty laid-out and measured model. Never reset
  // the camera later.
  useEffect(() => {
    if (fitted.current || !model || model.nodes.length === 0) return;

    if (layout.generation === 0 || !initialized) return;

    fitted.current = true;
    // Instant: an animated first fit stalls when the tab is not yet visible.
    // Small graphs stay at 1:1, the scale the screens are drawn at.
    void flow.fitView({ padding: 0.2, duration: 0, maxZoom: 1 });
  }, [flow, model, layout.generation, initialized]);

  // The nodes and edges are controlled, so React Flow reports selection only as
  // changes. A click emits the new selection and deselects the old one, across
  // the node and edge handlers; collect one tick so a selection wins.
  const pendingSelection = useRef<string | null | undefined>(undefined);
  const collectSelection = useCallback(
    (changes: readonly (NodeChange | EdgeChange)[]) => {
      const before = pendingSelection.current;

      for (const change of changes) {
        if (change.type !== 'select') continue;

        if (change.selected) pendingSelection.current = change.id;
        else if (pendingSelection.current === undefined)
          pendingSelection.current = null;
      }

      if (before !== undefined || pendingSelection.current === undefined)
        return;

      queueMicrotask(() => {
        const next = pendingSelection.current;

        pendingSelection.current = undefined;

        if (next !== undefined) onSelect(next);
      });
    },
    [onSelect],
  );

  return (
    <div
      className={`graph-canvas${reducedMotion ? ' reduced-motion' : ''}`}
      data-generation={generation}
    >
      <ArrowMarkers />
      <DockContext value={dock}>
        <ReactFlow<ModelFlowNode, ModelFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          edgesReconnectable={false}
          edgesFocusable
          nodesFocusable
          deleteKeyCode={null}
          panOnScroll
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={2}
          onNodesChange={collectSelection}
          onEdgesChange={collectSelection}
          proOptions={{ hideAttribution: true }}
          // React Flow tags its root with .light/.dark, which also scopes the
          // theme tokens; follow the system like the shell does.
          colorMode={theme}
        />
      </DockContext>
      {model && model.nodes.length > 0 && (
        <div
          className="graph-controls"
          role="toolbar"
          aria-label="View controls"
        >
          <Button
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => void flow.zoomOut({ duration })}
          >
            −
          </Button>
          <Button
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => void flow.zoomIn({ duration })}
          >
            +
          </Button>
          <Button
            title="Fit the graph in view"
            onClick={() => void flow.fitView({ padding: 0.2, duration })}
          >
            Fit
          </Button>
        </div>
      )}
    </div>
  );
}
