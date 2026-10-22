import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { ModelFlowNode } from './ModelGraph.js';
import type { GraphNodeData } from './map.js';
import { Icon, RelateMark } from '../icons.js';
import { SystemLogo, isSystemName, systemTitle } from './systems.js';
import { DatasetDock, useHoverIntent } from './DatasetDock.js';

/** The provider's logo when the runtime reported a known system, else a generic database. */
function SourceMark(props: { readonly system: string | undefined }) {
  return props.system && isSystemName(props.system) ? (
    <SystemLogo system={props.system} />
  ) : (
    <Icon name="database" size={12} />
  );
}

function named(system: string | undefined): string {
  if (!system) return '';

  return `${isSystemName(system) ? systemTitle(system) : system} · `;
}

/** Square tab on the card's top edge naming who owns the records; the hover title gives the detail. */
function OwnerTab(props: { readonly data: GraphNodeData }) {
  const { data } = props;

  if (data.kind === 'dataset')
    return (
      <span
        className="object-node-owner dataset"
        title={`${named(data.system)}Analytical dataset`}
      >
        <SourceMark system={data.system} />
      </span>
    );

  if (data.ownership.kind === 'source')
    return (
      <span
        className="object-node-owner"
        title={`${named(data.ownership.system)}Owned by source ${data.ownership.sourceId}`}
      >
        <SourceMark system={data.ownership.system} />
      </span>
    );

  return (
    <span
      className="object-node-owner native"
      title="Records are owned by Relate"
    >
      <RelateMark size={12} />
    </span>
  );
}

/** Compact object or dataset card: label, API name, owner tab and docked datasets. Details live in the panel. */
export const ModelNode = memo(function ModelNode(
  props: NodeProps<ModelFlowNode>,
) {
  const { data, selected } = props;
  const { open, ...hover } = useHoverIntent();

  return (
    <div
      className={`object-node${data.kind === 'dataset' ? ' dataset' : ''}${
        open ? ' dock-open' : ''
      }${
        selected ? ' selected' : ''
      }${data.issues > 0 ? ' highlighted' : ''}${data.touched ? ' touched' : ''}`}
      data-definition-id={data.id}
      title={data.description ?? data.id}
      {...(data.docked.length > 0 ? hover : {})}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="object-node-text">
        <span className="object-node-label">{data.label}</span>
        <span className="object-node-api-name">{data.apiName}</span>
      </div>
      <OwnerTab data={data} />
      {data.issues > 0 && (
        <span
          className="object-node-badge"
          aria-label={`${data.issues} issues`}
        >
          {data.issues}
        </span>
      )}
      {data.docked.length > 0 && (
        <DatasetDock docked={data.docked} open={open} />
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
