import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { RelationshipFlowEdge } from './ModelGraph.js';

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

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`relationship-edge${state}`}
        interactionWidth={16}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
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
