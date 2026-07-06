// Loads the binary graph exported by `pnpm export:graph` and exposes the CSR
// arrays as views over a single ArrayBuffer. Mirrors the layout in
// src/export-graph.ts exactly.

export type GraphBounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export type Graph = {
  n: number;
  e: number;
  offsets: Int32Array;     // [n+1]
  targets: Int32Array;     // [e]
  distances: Float64Array; // [e] edge length in metres
  classes: Uint8Array;     // [e] road class id
  nameIds: Uint32Array;    // [e] street-name id; index into `names`
  names: string[];         // name dictionary (names[0] === '')
  lats: Float64Array;      // [n]
  lons: Float64Array;      // [n]
  scc: Uint8Array;         // [n] 1 = node is in the largest SCC
  bounds: GraphBounds;
};

const MAGIC = 0x47524150; // "GRAP"

export async function loadGraph(): Promise<Graph> {
  const [metaRes, binRes, namesRes] = await Promise.all([
    fetch('meta.json'),
    fetch('graph.bin'),
    fetch('names.json'),
  ]);
  if (!metaRes.ok || !binRes.ok || !namesRes.ok) {
    throw new Error('failed to fetch graph data — run `pnpm export:graph`');
  }

  const meta = (await metaRes.json()) as { bounds: GraphBounds };
  const names = (await namesRes.json()) as string[];
  const ab = await binRes.arrayBuffer();

  const hdr = new Int32Array(ab, 0, 4);
  if (hdr[0] !== MAGIC) throw new Error('bad graph.bin magic');
  const n = hdr[1]!;
  const e = hdr[2]!;
  const version = hdr[3]!;
  if (version < 2) throw new Error('graph.bin missing classes/names — re-run `pnpm export:graph`');

  const HEADER = 16;
  const offTargets = HEADER + 4 * (n + 1);
  const intsEnd = offTargets + 4 * e;
  const offDist = Math.ceil(intsEnd / 8) * 8;
  const offLats = offDist + 8 * e;
  const offLons = offLats + 8 * n;
  const offClasses = offLons + 8 * n;
  const offNameIds = Math.ceil((offClasses + e) / 4) * 4;
  const offSCC = offNameIds + 4 * e;
  const scc = version >= 3
    ? new Uint8Array(ab, offSCC, n)
    : new Uint8Array(n).fill(1);

  return {
    n,
    e,
    offsets: new Int32Array(ab, HEADER, n + 1),
    targets: new Int32Array(ab, offTargets, e),
    distances: new Float64Array(ab, offDist, e),
    classes: new Uint8Array(ab, offClasses, e),
    nameIds: new Uint32Array(ab, offNameIds, e),
    names,
    lats: new Float64Array(ab, offLats, n),
    lons: new Float64Array(ab, offLons, n),
    scc,
    bounds: meta.bounds,
  };
}

// Precomputed per-node minimum edge class (lowest class number = highest-ranked road).
// Computed lazily once per Graph instance; reused across all nearestNode calls.
const _bestClassCache = new WeakMap<Graph, Uint8Array>();

function getBestClass(graph: Graph): Uint8Array {
  let cache = _bestClassCache.get(graph);
  if (cache) return cache;
  const { n, offsets, classes } = graph;
  cache = new Uint8Array(n).fill(7);
  for (let i = 0; i < n; i++) {
    for (let ei = offsets[i]!; ei < offsets[i + 1]!; ei++) {
      if (classes[ei]! < cache[i]!) cache[i] = classes[ei]!;
    }
  }
  _bestClassCache.set(graph, cache);
  return cache;
}

// Uniform lat/lon grid over the routable (largest-SCC) nodes, built once per
// Graph. Turns nearestNode's O(N) scan into an expanding-ring lookup over a
// few grid cells. CSR-style buckets: nodes of cell c are
// items[cellStart[c]..cellStart[c+1]).
type GridIndex = {
  minLat: number; minLon: number;
  invCellLat: number; invCellLon: number; // 1 / cell span, degrees
  cellLat: number; cellLon: number;
  rows: number; cols: number;
  cellStart: Int32Array;
  items: Int32Array;
};

const GRID_DIM = 256; // 256×256 ≈ 14 nodes/cell at 915k nodes

const _gridCache = new WeakMap<Graph, GridIndex>();

function getGrid(graph: Graph): GridIndex {
  let grid = _gridCache.get(graph);
  if (grid) return grid;
  const { n, lats, lons, scc } = graph;

  let hasScc = false;
  for (let i = 0; i < n; i++) if (scc[i]) { hasScc = true; break; }
  // scc all-zero would previously make nearestNode recurse forever; index all
  // nodes instead so lookups still terminate.
  const use = (i: number) => hasScc ? scc[i]! !== 0 : true;

  // Bounds from the indexed nodes themselves (graph.bounds may be stale).
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!use(i)) continue;
    count++;
    const la = lats[i]!, lo = lons[i]!;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  const rows = GRID_DIM, cols = GRID_DIM;
  // Epsilon keeps the max-coordinate node inside the last cell.
  const cellLat = Math.max((maxLat - minLat) / rows, 1e-9) * (1 + 1e-12);
  const cellLon = Math.max((maxLon - minLon) / cols, 1e-9) * (1 + 1e-12);

  const cellOf = (i: number) => {
    const r = Math.min(rows - 1, Math.floor((lats[i]! - minLat) / cellLat));
    const c = Math.min(cols - 1, Math.floor((lons[i]! - minLon) / cellLon));
    return r * cols + c;
  };

  const cellStart = new Int32Array(rows * cols + 1);
  for (let i = 0; i < n; i++) if (use(i)) cellStart[cellOf(i) + 1]++;
  for (let c = 0; c < rows * cols; c++) cellStart[c + 1] += cellStart[c]!;
  const items = new Int32Array(count);
  const fill = cellStart.slice(0, rows * cols);
  for (let i = 0; i < n; i++) if (use(i)) items[fill[cellOf(i)]!++] = i;

  grid = {
    minLat, minLon,
    invCellLat: 1 / cellLat, invCellLon: 1 / cellLon,
    cellLat, cellLon, rows, cols, cellStart, items,
  };
  _gridCache.set(graph, grid);
  return grid;
}

// Nearest indexed node accepted by `accept`, by expanding square rings of grid
// cells. After finishing ring r, any node in ring r+1 or beyond is at least
// r*minSpan away, so the search stops as soon as the best hit beats that bound.
function gridNearest(
  grid: GridIndex, graph: Graph, lat: number, lon: number,
  accept: ((i: number) => boolean) | null,
): number {
  const { minLat, minLon, cellLat, cellLon, rows, cols, cellStart, items } = grid;
  const { lats, lons } = graph;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const minSpan = Math.min(cellLat, cellLon * cosLat);

  const r0 = Math.min(rows - 1, Math.max(0, Math.floor((lat - minLat) / cellLat)));
  const c0 = Math.min(cols - 1, Math.max(0, Math.floor((lon - minLon) / cellLon)));

  let best = -1, bestD = Infinity;
  const maxRing = Math.max(rows, cols);

  const scanCell = (r: number, c: number): void => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    const cell = r * cols + c;
    for (let k = cellStart[cell]!; k < cellStart[cell + 1]!; k++) {
      const i = items[k]!;
      if (accept && !accept(i)) continue;
      const dLat = lats[i]! - lat;
      const dLon = (lons[i]! - lon) * cosLat;
      const d = dLat * dLat + dLon * dLon;
      if (d < bestD) { bestD = d; best = i; }
    }
  };

  for (let ring = 0; ring <= maxRing; ring++) {
    // A node in ring `ring` lies in a cell whose nearest edge is at least
    // (ring-1) cells from the query cell — stop once that bound beats bestD.
    if (best >= 0) {
      const bound = (ring - 1) * minSpan;
      if (bound > 0 && bestD <= bound * bound) break;
    }
    if (ring === 0) {
      scanCell(r0, c0);
      continue;
    }
    for (let c = c0 - ring; c <= c0 + ring; c++) {
      scanCell(r0 - ring, c);
      scanCell(r0 + ring, c);
    }
    for (let r = r0 - ring + 1; r <= r0 + ring - 1; r++) {
      scanCell(r, c0 - ring);
      scanCell(r, c0 + ring);
    }
  }
  return best;
}

// Nearest graph node to a lat/lng, restricted to the largest SCC.
//
// maxClass (optional): only consider nodes that have at least one outgoing edge
// of class ≤ maxClass. Use 3 (secondary) for drive-mode snapping so the origin/
// destination lands on a real arterial rather than a mall access or service road,
// which can otherwise add 1-2 km of detour before the router reaches the main
// corridor. Prefers intersection nodes (out-degree ≥ 2) so we never start a
// route on a one-way stub, then falls back to any arterial node, then to an
// unrestricted search — same preference order as the old linear scan.
export function nearestNode(graph: Graph, lat: number, lon: number, maxClass = 7): number {
  const grid = getGrid(graph);
  const { offsets } = graph;
  if (maxClass < 7) {
    const bestClass = getBestClass(graph);
    const arterialJunction = (i: number) =>
      bestClass[i]! <= maxClass && offsets[i + 1]! - offsets[i]! >= 2;
    const hit = gridNearest(grid, graph, lat, lon, arterialJunction);
    if (hit >= 0) return hit;
    const anyArterial = gridNearest(grid, graph, lat, lon, (i) => bestClass[i]! <= maxClass);
    if (anyArterial >= 0) return anyArterial;
  }
  return gridNearest(grid, graph, lat, lon, null);
}

// Index of the cheapest edge a->b (parallel edges are rare), or -1 if none.
// Shared by routing, directions and the traffic model, which all need to map a
// path's adjacent node pair back to a single edge.
export function cheapestEdge(graph: Graph, a: number, b: number): number {
  let ei = -1, best = Infinity;
  for (let x = graph.offsets[a]!; x < graph.offsets[a + 1]!; x++) {
    if (graph.targets[x] === b && graph.distances[x]! < best) { best = graph.distances[x]!; ei = x; }
  }
  return ei;
}

export { haversine } from '../../src/lib/geo.ts';
