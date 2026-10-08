import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { RelationshipFlowEdge } from './ModelGraph.js';

export type ArrowMarker = 'default' | 'selected' | 'highlighted';

export const arrowMarkerId = (marker: ArrowMarker) => `relate-arrow-${marker}`;

/** Arrowheads shared by every edge; colors follow the edge state. */
export function ArrowMarkers() {
  const fills: Record<ArrowMarker, string> = {
    default: 'var(--t-border-color-strong)',
    selected: 'var(--t-color-blue9)',
    highlighted: 'var(--t-color-red9)',
  };

  return (
    <svg className="arrow-markers" aria-hidden="true">
      <defs>
        {(Object.keys(fills) as ArrowMarker[]).map((marker) => (
          <marker
            key={marker}
            id={arrowMarkerId(marker)}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" style={{ fill: fills[marker] }} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export const RelationshipEdge = memo(function RelationshipEdge(
  props: EdgeProps<RelationshipFlowEdge>,
) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    data,
  } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const state = `${selected ? ' selected' : ''}${data?.highlighted ? ' highlighted' : ''}`;
  const marker = data?.highlighted
    ? 'highlighted'
    : selected
      ? 'selected'
      : 'default';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`relationship-edge${state}`}
        interactionWidth={16}
        markerEnd={`url(#${arrowMarkerId(marker)})`}
      />
      {data && (
        <EdgeLabelRenderer>
          <div
            className={`relationship-label${state}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            data-definition-id={data.id}
            title={`${data.id} via ${data.viaProperty}`}
          >
            <span className="names">
              {data.forward.name} <span className="arrows">⇄</span>{' '}
              {data.reverse.name}
            </span>
            <span className="cardinality">
              {data.reverse.cardinality === 'one' ? '1' : 'N'} :{' '}
              {data.forward.cardinality === 'many' ? 'N' : '1'}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
