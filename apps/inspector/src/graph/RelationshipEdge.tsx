import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
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
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={`relationship-edge${selected ? ' selected' : ''}${
          data?.highlighted ? ' highlighted' : ''
        }`}
        interactionWidth={16}
      />
      {data && (
        <EdgeLabelRenderer>
          <div
            className={`relationship-label${selected ? ' selected' : ''}${
              data.highlighted ? ' highlighted' : ''
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            data-definition-id={data.id}
            title={`${data.id} via ${data.viaProperty}`}
          >
            <span className="traversal traversal-forward">
              {data.forward.name}
              <small>{data.forward.cardinality}</small>
            </span>
            <span className="traversal traversal-reverse">
              {data.reverse.name}
              <small>{data.reverse.cardinality}</small>
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
