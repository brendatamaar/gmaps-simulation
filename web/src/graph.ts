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
    bounds: meta.bounds,
  };
}

// Nearest graph node to a lat/lng. Linear scan, fine for one city.
export function nearestNode(graph: Graph, lat: number, lon: number): number {
  const { n, lats, lons } = graph;
  // Squared planar distance is enough for "nearest"; cos-correct the longitude
  // so the comparison isn't skewed near the equator.
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dLat = lats[i]! - lat;
    const dLon = (lons[i]! - lon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
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

const EARTH_R = 6_371_000;

// Great-circle distance in metres between two lat/lon points.
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.asin(Math.sqrt(a));
}
