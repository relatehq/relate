/**
 * ELK layered layout adapter. Pure with respect to the DOM: it receives node
 * dimensions and returns positions, so it runs in a Web Worker in the browser
 * and directly in Node for tests.
 */
import type { ElkNode } from 'elkjs/lib/elk-api.js';

export interface LayoutNodeInput {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEdgeInput {
  readonly id: string;
  readonly source: string;
  readonly target: string;
}

export interface LayoutRequest {
  /** The model generation this layout belongs to; obsolete results are discarded. */
  readonly generation: number;
  readonly nodes: readonly LayoutNodeInput[];
  readonly edges: readonly LayoutEdgeInput[];
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface LayoutResult {
  readonly generation: number;
  readonly positions: Readonly<Record<string, Position>>;
}

export type LayoutResponse =
  | { readonly ok: true; readonly result: LayoutResult }
  | {
      readonly ok: false;
      readonly generation: number;
      readonly message: string;
    };

/** Mirrors Arc's layered preset: left-to-right, orthogonal routing, fixed seed. */
export const layeredOptions: Readonly<Record<string, string>> = Object.freeze({
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '60',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.spacing.componentComponent': '80',
  'elk.randomSeed': '42',
});

const byId = <T extends { readonly id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/** Build the ELK input deterministically: stable ID order, explicit sizes. */
export function toElkGraph(request: LayoutRequest): ElkNode {
  const ids = new Set(request.nodes.map((node) => node.id));

  return {
    id: 'model',
    layoutOptions: { ...layeredOptions },
    children: [...request.nodes].sort(byId).map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
    })),
    edges: [...request.edges]
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .sort(byId)
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
  };
}

export async function layoutWithElk(
  request: LayoutRequest,
  elk: ElkLike,
): Promise<LayoutResult> {
  if (request.nodes.length === 0)
    return { generation: request.generation, positions: {} };

  const result = await elk.layout(toElkGraph(request));
  const positions: Record<string, Position> = {};

  for (const child of result.children ?? []) {
    if (!Number.isFinite(child.x) || !Number.isFinite(child.y))
      throw new Error(`ELK returned no position for ${child.id}`);

    positions[child.id] = { x: child.x!, y: child.y! };
  }

  for (const node of request.nodes)
    if (!positions[node.id])
      throw new Error(`ELK returned no position for ${node.id}`);

  return { generation: request.generation, positions };
}
