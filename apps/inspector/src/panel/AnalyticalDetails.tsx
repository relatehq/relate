import type {
  AssociationEdgeData,
  DatasetNodeData,
  ObjectNodeData,
} from '../graph/map.js';

/** Authoring metadata from the local manifest, not actor-scoped discovery. */
export function DatasetDetails({ data }: { readonly data: DatasetNodeData }) {
  return (
    <>
      <dl className="detail-rows facts">
        <dt>ID</dt>
        <dd>{data.id}</dd>
        <dt>API name</dt>
        <dd>{data.apiName}</dd>
        <dt>Kind</dt>
        <dd className="prose">Analytical dataset</dd>
        {data.description && (
          <>
            <dt>About</dt>
            <dd className="prose">{data.description}</dd>
          </>
        )}
      </dl>
      <div className="section-label">Columns</div>
      <div className="property-list">
        {data.columns.map((column) => (
          <div
            key={column.id}
            className="row"
            title={`${column.id}${column.description ? ` · ${column.description}` : ''}`}
          >
            <span className="name">
              {column.name}
              <span className="analytical-access">
                Group: {column.access}
                {column.role ? ` · role: ${column.role}` : ''}
              </span>
            </span>
            <span className="type">{column.type}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function ComputedDetails({
  calculations,
}: {
  readonly calculations: ObjectNodeData['calculations'];
}) {
  if (calculations.length === 0) return null;

  return (
    <>
      <div className="section-label">Computed properties</div>
      <div className="property-list">
        {calculations.map((calculation) => (
          <div
            key={calculation.id}
            className="row"
            title={`${calculation.id}${calculation.description ? ` · ${calculation.description}` : ''}`}
          >
            <span className="name">
              {calculation.name}
              <span className="analytical-access">
                Group: {calculation.access}
              </span>
            </span>
            <span className="type">computed</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function AssociationDetails(props: {
  readonly data: AssociationEdgeData;
  readonly objectName: string;
  readonly datasetName: string;
}) {
  const { data, objectName, datasetName } = props;

  return (
    <div className="relationship-card">
      <span className="name">{data.name}</span>
      <span className="endpoints">
        {objectName} → {datasetName} · dataset association
      </span>
      <span className="traversals">Required role: {data.role}</span>
      <dl className="detail-rows">
        <dt>ID</dt>
        <dd>{data.id}</dd>
        <dt>Correlation</dt>
        <dd>
          {data.on.map((pair, index) => (
            <div key={index}>
              {datasetName}.{pair.column} = {objectName}.{pair.property}
            </div>
          ))}
        </dd>
      </dl>
    </div>
  );
}
