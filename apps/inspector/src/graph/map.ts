/**
 * Pure mapping from a validated Manifest to graph nodes and edges. No React
 * Flow or DOM types here so the mapping is testable in Node.
 */
import type { Manifest } from 'relate/model';

type ManifestObject = Manifest['objects'][number];

type ManifestProperty = ManifestObject['properties'][number];

type ManifestRelationship = NonNullable<Manifest['relationships']>[number];

export interface PropertyView {
  readonly id: string;
  readonly name: string;
  /** Human-readable scalar type such as `string`, `number?` or `boolean | null`. */
  readonly type: string;
  readonly access: string;
  readonly origin: ManifestProperty['origin']['kind'];
  /** Target object definition ID for references. */
  readonly target?: string;
  /** Source field for source-backed properties and references. */
  readonly field?: string;
}

export type Ownership =
  | { readonly kind: 'source'; readonly sourceId: string }
  | { readonly kind: 'native' };

// Type aliases (not interfaces) so React Flow's Record<string, unknown> data constraint holds.
export type ObjectNodeData = {
  readonly id: string;
  readonly apiName: string;
  readonly label: string;
  readonly pluralLabel: string;
  readonly description?: string;
  readonly ownership: Ownership;
  readonly properties: readonly PropertyView[];
};

export type RelationshipEdgeData = {
  readonly id: string;
  readonly forward: ManifestRelationship['forward'];
  readonly reverse: ManifestRelationship['reverse'];
  readonly viaProperty: string;
};

export interface GraphNode {
  readonly id: string;
  readonly data: ObjectNodeData;
}

export interface GraphEdge {
  readonly id: string;
  /** The `from` object: traversing `forward` from it reaches many `target`s. */
  readonly source: string;
  readonly target: string;
  readonly data: RelationshipEdgeData;
}

export interface GraphModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export function describeScalar(schema: ManifestProperty['schema']): string {
  return `${schema.type}${schema.nullable ? ' | null' : ''}${schema.optional ? '?' : ''}`;
}

function propertyView(property: ManifestProperty): PropertyView {
  const origin = property.origin;

  return {
    id: property.id,
    name: property.name,
    type: describeScalar(property.schema),
    access: property.access,
    origin: origin.kind,
    ...('targetObjectDefinitionId' in origin
      ? { target: origin.targetObjectDefinitionId }
      : {}),
    ...('field' in origin ? { field: origin.field } : {}),
  };
}

const byId = <T extends { readonly id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Object types become nodes; declared relationships become edges. Reference properties alone never do. */
export function mapManifest(manifest: Manifest): GraphModel {
  const objects = new Map(manifest.objects.map((o) => [o.id, o] as const));
  const nodes = [...manifest.objects].sort(byId).map((object): GraphNode => ({
    id: object.id,
    data: {
      id: object.id,
      apiName: object.apiName,
      label: object.label,
      pluralLabel: object.pluralLabel,
      ...(object.description !== undefined
        ? { description: object.description }
        : {}),
      ownership: object.sourceDefinitionId
        ? { kind: 'source', sourceId: object.sourceDefinitionId }
        : { kind: 'native' },
      properties: [...object.properties]
        .sort((a, b) => {
          // Identity first, then declaration order by stable ID.
          const identity =
            Number(b.origin.kind === 'object-id') -
            Number(a.origin.kind === 'object-id');

          return identity || byId(a, b);
        })
        .map(propertyView),
    },
  }));
  const edges = [...(manifest.relationships ?? [])]
    .sort(byId)
    .flatMap((relationship): GraphEdge[] => {
      const owner = objects.get(relationship.toObjectDefinitionId);
      const via = owner?.properties.find(
        (p) => p.id === relationship.referencePropertyDefinitionId,
      );

      // A validated manifest always resolves these; stay defensive anyway.
      if (!objects.has(relationship.fromObjectDefinitionId) || !owner || !via)
        return [];

      return [
        {
          id: relationship.id,
          source: relationship.fromObjectDefinitionId,
          target: relationship.toObjectDefinitionId,
          data: {
            id: relationship.id,
            forward: relationship.forward,
            reverse: relationship.reverse,
            viaProperty: via.name,
          },
        },
      ];
    });

  return { nodes, edges };
}

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 60;

/** Dimensions ELK lays out with; the rendered card matches them through CSS. */
export function estimateNodeSize(data: ObjectNodeData): {
  readonly width: number;
  readonly height: number;
} {
  void data;

  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

/** Changes when topology or node sizes change; presentation-only edits leave it alone. */
export function layoutSignature(model: GraphModel): string {
  return JSON.stringify([
    model.nodes.map((node) => [node.id, estimateNodeSize(node.data).height]),
    model.edges.map((edge) => [edge.id, edge.source, edge.target]),
  ]);
}

/** Definition IDs of nodes/edges present in the displayed model; only these may be highlighted. */
export function highlightable(
  model: GraphModel | null,
  definitionIds: readonly string[],
): {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
} {
  const nodes = new Set<string>();
  const edges = new Set<string>();

  if (!model) return { nodes, edges };

  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const edgeIds = new Set(model.edges.map((e) => e.id));

  for (const id of definitionIds) {
    // An ID shared by a node and an edge would be ambiguous; skip it.
    if (nodeIds.has(id) && !edgeIds.has(id)) nodes.add(id);
    else if (edgeIds.has(id) && !nodeIds.has(id)) edges.add(id);
  }

  return { nodes, edges };
}
