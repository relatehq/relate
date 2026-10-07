import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { ObjectFlowNode } from './ModelGraph.js';
import type { PropertyView } from './map.js';

function originLabel(property: PropertyView): string {
  switch (property.origin) {
    case 'object-id':
      return 'id';
    case 'reference':
    case 'native-reference':
      return `→ ${property.target ?? '?'}`;
    case 'native':
      return 'native';
    case 'source':
      return property.field ?? 'source';
  }
}

export const ObjectNode = memo(function ObjectNode(
  props: NodeProps<ObjectFlowNode>,
) {
  const { data, selected } = props;
  const ownership =
    data.ownership.kind === 'source'
      ? { text: data.ownership.sourceId, className: 'badge badge-source' }
      : { text: 'relate-owned', className: 'badge badge-native' };

  return (
    <div
      className={`object-node${selected ? ' selected' : ''}${
        data.highlighted ? ' highlighted' : ''
      }`}
      data-definition-id={data.id}
      title={data.description}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <header className="object-node-header">
        <div className="object-node-title">
          <span className="object-node-label">{data.label}</span>
          {data.label !== data.apiName && (
            <code className="object-node-api-name">{data.apiName}</code>
          )}
        </div>
        <span className={ownership.className} title="Record ownership">
          {ownership.text}
        </span>
      </header>
      <ul className="object-node-properties">
        {data.properties.map((property) => (
          <li
            key={property.id}
            className={`property property-${property.origin}${
              property.access !== 'ordinary' ? ' property-restricted' : ''
            }`}
            title={`${property.id} · ${property.access}`}
          >
            <span className="property-name">{property.name}</span>
            <span className="property-type">{property.type}</span>
            <span className="property-origin">{originLabel(property)}</span>
          </li>
        ))}
      </ul>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
