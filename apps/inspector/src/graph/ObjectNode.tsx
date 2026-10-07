import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { ObjectFlowNode } from './ModelGraph.js';
import { Tag } from '../ui.js';

/** Compact object-type card: label, API name and ownership. Details live in the panel. */
export const ObjectNode = memo(function ObjectNode(
  props: NodeProps<ObjectFlowNode>,
) {
  const { data, selected } = props;

  return (
    <div
      className={`object-node${selected ? ' selected' : ''}${
        data.issues > 0 ? ' highlighted' : ''
      }`}
      data-definition-id={data.id}
      title={data.description ?? data.id}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="object-node-text">
        <span className="object-node-label">{data.label}</span>
        <span className="object-node-api-name">{data.apiName}</span>
      </div>
      {data.ownership.kind === 'source' ? (
        <Tag color="blue" title={`Owned by source ${data.ownership.sourceId}`}>
          {data.ownership.sourceId}
        </Tag>
      ) : (
        <Tag color="purple" title="Records are owned by Relate">
          Relate
        </Tag>
      )}
      {data.issues > 0 && (
        <span
          className="object-node-badge"
          aria-label={`${data.issues} issues`}
        >
          {data.issues}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
