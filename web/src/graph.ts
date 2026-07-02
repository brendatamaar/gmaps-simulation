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

// Nearest graph node to a lat/lng, restricted to the largest SCC.
//
// maxClass (optional): only consider nodes that have at least one outgoing edge
// of class ≤ maxClass. Use 3 (secondary) for drive-mode snapping so the origin/
// destination lands on a real arterial rather than a mall access or service road,
// which can otherwise add 1-2 km of detour before the router reaches the main
// corridor. Falls back to unrestricted search if no qualifying node is found.
export function nearestNode(graph: Graph, lat: number, lon: number, maxClass = 7): number {
  const { n, lats, lons, scc, offsets } = graph;
  const bestClass = maxClass < 7 ? getBestClass(graph) : null;
  const cosLat = Math.cos((lat * Math.PI) / 180);

  // For drive-mode snapping (maxClass < 7) prefer intersection nodes (out-degree ≥ 2)
  // so we never start a route on a one-way stub that forces the router to first travel
  // in the wrong direction before reaching the arterial network.
  let best = -1;       // nearest arterial node with out-degree ≥ 2
  let bestD = Infinity;
  let bestAny = -1;    // nearest arterial node of any degree (fallback)
  let bestAnyD = Infinity;

  for (let i = 0; i < n; i++) {
    if (!scc[i]) continue;
    if (bestClass && bestClass[i]! > maxClass) continue;
    const dLat = lats[i]! - lat;
    const dLon = (lons[i]! - lon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestAnyD) { bestAnyD = d; bestAny = i; }
    if (maxClass < 7 && offsets[i + 1]! - offsets[i]! < 2) continue;
    if (d < bestD) { bestD = d; best = i; }
  }

  if (best >= 0) return best;
  if (bestAny >= 0) return bestAny;
  return nearestNode(graph, lat, lon); // final fallback: unrestricted
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
