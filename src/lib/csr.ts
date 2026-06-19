import type { AdjList } from '../build-graph.ts';
import type { NodeCoord } from './parser.ts';

export type CSR = {
  n: number;
  offsets: Int32Array;
  targets: Int32Array;
  distances: Float64Array;
  nodeIds: number[];
  idToIndex: Map<number, number>;
  lats: Float64Array;
  lons: Float64Array;
};

export function buildCSR(adj: AdjList, nodeCoords: Map<number, NodeCoord>): CSR {
  const nodeIds = [...adj.keys()];
  const n = nodeIds.length;
  const idToIndex = new Map<number, number>(nodeIds.map((id, i) => [id, i]));

  const lats = new Float64Array(n);
  const lons = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const coord = nodeCoords.get(nodeIds[i]!);
    if (coord) { lats[i] = coord.lat; lons[i] = coord.lon; }
  }

  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    offsets[i + 1] = offsets[i] + (adj.get(nodeIds[i]!)?.length ?? 0);
  }
  const e = offsets[n]!;

  const targets = new Int32Array(e);
  const distances = new Float64Array(e);
  for (let i = 0; i < n; i++) {
    const edges = adj.get(nodeIds[i]!);
    if (!edges) continue;
    const base = offsets[i]!;
    for (let j = 0; j < edges.length; j++) {
      const toIdx = idToIndex.get(edges[j]!.to);
      targets[base + j] = toIdx ?? -1;
      distances[base + j] = edges[j]!.dist;
    }
  }

  return { n, offsets, targets, distances, nodeIds, idToIndex, lats, lons };
}
