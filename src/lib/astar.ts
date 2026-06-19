import { MinHeap } from './heap.ts';
import { haversine } from './geo.ts';
import type { CSR } from './csr.ts';

export type AStarResult = {
  path: number[];       // node indices from start to end
  distMeters: number;
  nodesVisited: number;
};

export function astar(csr: CSR, startIdx: number, endIdx: number): AStarResult | null {
  const { n, offsets, targets, distances, lats, lons } = csr;

  const gScore = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);

  const endLat = lats[endIdx]!;
  const endLon = lons[endIdx]!;
  const h = (i: number) => haversine(lats[i]!, lons[i]!, endLat, endLon);

  gScore[startIdx] = 0;
  const heap = new MinHeap();
  heap.push(startIdx, h(startIdx));

  let nodesVisited = 0;

  while (heap.size > 0) {
    const { node: cur } = heap.pop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;
    nodesVisited++;

    if (cur === endIdx) break;

    const edgeStart = offsets[cur]!;
    const edgeEnd = offsets[cur + 1]!;
    for (let e = edgeStart; e < edgeEnd; e++) {
      const nb = targets[e]!;
      if (nb === -1 || closed[nb]) continue;
      const tentative = gScore[cur]! + distances[e]!;
      if (tentative < gScore[nb]!) {
        gScore[nb] = tentative;
        parent[nb] = cur;
        heap.push(nb, tentative + h(nb));
      }
    }
  }

  if (gScore[endIdx] === Infinity) return null;

  const path: number[] = [];
  let cur = endIdx;
  while (cur !== -1) {
    path.push(cur);
    cur = parent[cur]!;
  }
  path.reverse();

  return { path, distMeters: gScore[endIdx]!, nodesVisited };
}

export function nearestNode(csr: CSR, lat: number, lon: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < csr.n; i++) {
    const d = haversine(lat, lon, csr.lats[i]!, csr.lons[i]!);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}
