import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildGraph } from './build-graph.ts';
import type { OsmRestriction } from './build-graph.ts';
import { buildCSR } from './lib/csr.ts';

// Serializes the CSR graph to a compact little-endian binary the browser can
// fetch and feed straight into WASM linear memory. The 892 MB PBF stays on the
// Node side; the browser never parses OSM.
//
// Layout (all little-endian, sections that hold f64 are 8-byte aligned):
//   [0]   magic   i32  = 0x47524150 ("GRAP")
//   [4]   n       i32
//   [8]   e       i32
//   [12]  version i32  = 3 (>=1 ⇒ `classes`; >=2 ⇒ `nameIds` + names.json; >=3 ⇒ `scc` flags)
//   offsets   i32 * (n+1)
//   targets   i32 * e
//   <pad to 8>
//   distances f64 * e
//   lats      f64 * n
//   lons      f64 * n
//   classes   u8  * e   (road class per edge, drives time/traffic weights)
//   <pad to 4>
//   nameIds   u32 * e   (street-name id per edge; names.json is the dictionary)
//   scc       u8  * n   (1 = node is in the largest strongly-connected component)

// Kosaraju's algorithm, iterative to avoid stack overflow on large graphs.
function largestSCC(n: number, offsets: Int32Array, targets: Int32Array): Uint8Array {
  const visited = new Uint8Array(n);
  const finishOrder = new Int32Array(n);
  let finishLen = 0;
  const stackU = new Int32Array(n);
  const stackEI = new Int32Array(n);
  let sp = 0;

  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    stackU[sp] = start; stackEI[sp] = offsets[start]!; sp++;
    while (sp > 0) {
      const top = sp - 1;
      const u = stackU[top]!;
      let ei = stackEI[top]!;
      const end = offsets[u + 1]!;
      let pushed = false;
      while (ei < end) {
        const v = targets[ei]!; ei++;
        if (!visited[v]) {
          visited[v] = 1;
          stackEI[top] = ei;
          stackU[sp] = v; stackEI[sp] = offsets[v]!; sp++;
          pushed = true; break;
        }
      }
      if (!pushed) { sp--; finishOrder[finishLen++] = u; }
    }
  }

  const revDeg = new Int32Array(n);
  for (let u = 0; u < n; u++) {
    for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) revDeg[targets[ei]!]++;
  }
  const revOff = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) revOff[i + 1] = revOff[i] + revDeg[i]!;
  const revTgt = new Int32Array(revOff[n]!);
  const pos = new Int32Array(n);
  for (let u = 0; u < n; u++) {
    for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) {
      const v = targets[ei]!;
      revTgt[revOff[v]! + pos[v]!] = u; pos[v]++;
    }
  }

  const comp = new Int32Array(n).fill(-1);
  let numComp = 0;
  const compSize: number[] = [];
  sp = 0;

  for (let k = finishLen - 1; k >= 0; k--) {
    const start = finishOrder[k]!;
    if (comp[start] !== -1) continue;
    const cid = numComp++;
    comp[start] = cid; let size = 1;
    stackU[0] = start; stackEI[0] = revOff[start]!; sp = 1;
    while (sp > 0) {
      const top = sp - 1;
      const u = stackU[top]!;
      let ei = stackEI[top]!;
      const end = revOff[u + 1]!;
      let pushed = false;
      while (ei < end) {
        const v = revTgt[ei]!; ei++;
        if (comp[v] === -1) {
          comp[v] = cid; size++;
          stackEI[top] = ei;
          stackU[sp] = v; stackEI[sp] = revOff[v]!; sp++;
          pushed = true; break;
        }
      }
      if (!pushed) sp--;
    }
    compSize.push(size);
  }

  let largestCid = 0, largestSize = 0;
  for (let c = 0; c < compSize.length; c++) {
    if (compSize[c]! > largestSize) { largestSize = compSize[c]!; largestCid = c; }
  }
  const scc = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (comp[i] === largestCid) scc[i] = 1; }
  return scc;
}

// Returns true if the edge from→to exists in the CSR graph.
function hasEdge(offsets: Int32Array, targets: Int32Array, from: number, to: number): boolean {
  for (let ei = offsets[from]!; ei < offsets[from + 1]!; ei++) {
    if (targets[ei] === to) return true;
  }
  return false;
}

// Converts OSM-ID-based turn restrictions into CSR-index triplets.
// 'only_*' restrictions are expanded into multiple 'no_*' restrictions
// (all outgoing edges from via except the permitted one become forbidden).
function resolveRestrictions(
  rawRestrictions: OsmRestriction[],
  wayRefs: Map<number, number[]>,
  idToIndex: Map<number, number>,
  offsets: Int32Array,
  targets: Int32Array,
): Array<{ from: number; via: number; to: number }> {
  const result: Array<{ from: number; via: number; to: number }> = [];

  for (const r of rawRestrictions) {
    const fromRefs = wayRefs.get(r.fromWayId);
    const toRefs   = wayRefs.get(r.toWayId);
    const viaIdx   = idToIndex.get(r.viaNodeId);
    if (!fromRefs || !toRefs || viaIdx === undefined) continue;

    // Find OSM node IDs adjacent to via in from_way that have an edge → via_idx.
    const fromNodes: number[] = [];
    for (let i = 0; i < fromRefs.length; i++) {
      if (fromRefs[i] === r.viaNodeId) {
        if (i > 0) fromNodes.push(fromRefs[i - 1]!);
        if (i + 1 < fromRefs.length) fromNodes.push(fromRefs[i + 1]!);
      }
    }
    const fromIdxs = fromNodes
      .map(id => idToIndex.get(id))
      .filter((idx): idx is number => idx !== undefined && hasEdge(offsets, targets, idx, viaIdx));

    // Find OSM node IDs adjacent to via in to_way that via_idx has an edge → to.
    const toNodes: number[] = [];
    for (let i = 0; i < toRefs.length; i++) {
      if (toRefs[i] === r.viaNodeId) {
        if (i > 0) toNodes.push(toRefs[i - 1]!);
        if (i + 1 < toRefs.length) toNodes.push(toRefs[i + 1]!);
      }
    }
    const toIdxs = toNodes
      .map(id => idToIndex.get(id))
      .filter((idx): idx is number => idx !== undefined && hasEdge(offsets, targets, viaIdx, idx));

    if (fromIdxs.length === 0 || toIdxs.length === 0) continue;

    if (r.type === 'no') {
      for (const fi of fromIdxs)
        for (const ti of toIdxs)
          result.push({ from: fi, via: viaIdx, to: ti });
    } else {
      // 'only_*': all outgoing from viaIdx except the allowed ones are forbidden.
      const allowed = new Set(toIdxs);
      for (const fi of fromIdxs) {
        for (let ei = offsets[viaIdx]!; ei < offsets[viaIdx + 1]!; ei++) {
          const nb = targets[ei]!;
          if (nb >= 0 && !allowed.has(nb))
            result.push({ from: fi, via: viaIdx, to: nb });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return result.filter(r => {
    const k = `${r.from},${r.via},${r.to}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '../web/public');
const WASM_SRC = path.join(__dirname, '../build/release.wasm');

const { adj, nodes, places, rawRestrictions, ways } = await buildGraph();

console.log('\nBuilding CSR...');
const csr = buildCSR(adj, nodes);
const { n, offsets, targets, distances, classes, nameIds, names, lats, lons } = csr;
const e = targets.length;
console.log(`  ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);

console.log('\nComputing largest SCC...');
const t0 = Date.now();
const scc = largestSCC(n, offsets, targets);
const sccSize = scc.reduce((a, b) => a + b, 0);
console.log(`  ${sccSize.toLocaleString()} / ${n.toLocaleString()} nodes in largest SCC (${(sccSize / n * 100).toFixed(1)}%) — ${Date.now() - t0} ms`);

// Bounds for the canvas coordinate transform.
let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
for (let i = 0; i < n; i++) {
  const la = lats[i]!, lo = lons[i]!;
  if (la < minLat) minLat = la;
  if (la > maxLat) maxLat = la;
  if (lo < minLng) minLng = lo;
  if (lo > maxLng) maxLng = lo;
}

const HEADER = 16;
const offTargets = HEADER + 4 * (n + 1);
const intsEnd = offTargets + 4 * e;
const offDist = Math.ceil(intsEnd / 8) * 8; // align f64 sections to 8 bytes
const offLats = offDist + 8 * e;
const offLons = offLats + 8 * n;
const offClasses = offLons + 8 * n;
const offNameIds = Math.ceil((offClasses + e) / 4) * 4; // align u32 to 4 bytes
const offSCC = offNameIds + 4 * e;
const total = offSCC + n;

const ab = new ArrayBuffer(total);
const hdr = new Int32Array(ab, 0, 4);
hdr[0] = 0x47524150;
hdr[1] = n;
hdr[2] = e;
hdr[3] = 3; // format version: classes + nameIds + scc flags
new Int32Array(ab, HEADER, n + 1).set(offsets);
new Int32Array(ab, offTargets, e).set(targets);
new Float64Array(ab, offDist, e).set(distances);
new Float64Array(ab, offLats, n).set(lats);
new Float64Array(ab, offLons, n).set(lons);
new Uint8Array(ab, offClasses, e).set(classes);
new Uint32Array(ab, offNameIds, e).set(nameIds);
new Uint8Array(ab, offSCC, n).set(scc);

console.log('\nResolving turn restrictions...');
const wayRefs = new Map<number, number[]>(ways.map(w => [w.id, w.refs]));
const resolvedRestrictions = resolveRestrictions(rawRestrictions, wayRefs, csr.idToIndex, offsets, targets);
console.log(`  ${rawRestrictions.length} raw → ${resolvedRestrictions.length} resolved (via+from+to triples)`);

// Group resolved restrictions by via node (sorted ascending for binary search in WASM).
const byVia = new Map<number, Array<{ from: number; to: number }>>();
for (const r of resolvedRestrictions) {
  let list = byVia.get(r.via);
  if (!list) { list = []; byVia.set(r.via, list); }
  list.push({ from: r.from, to: r.to });
}
const sortedVias = [...byVia.keys()].sort((a, b) => a - b);
const rViaCount  = sortedVias.length;
const rPairCount = resolvedRestrictions.length;

// restrictions.bin layout:
//   [0]  magic     u32 = 0x52455354 ("REST")
//   [4]  version   u32 = 1
//   [8]  viaCount  u32
//   [12] pairCount u32
//   via section  [16 + i*8]:     viaNode: i32  (sorted)
//   via section  [16 + i*8 + 4]: pairOff: i32  (start index in pairs section)
//   pair section [16 + viaCount*8 + j*8]:     from: i32
//   pair section [16 + viaCount*8 + j*8 + 4]: to:   i32
const rTotal = 16 + rViaCount * 8 + rPairCount * 8;
const rBuf = new ArrayBuffer(rTotal);
const rHdr = new Uint32Array(rBuf, 0, 4);
rHdr[0] = 0x52455354; rHdr[1] = 1; rHdr[2] = rViaCount; rHdr[3] = rPairCount;
const rViaView  = new Int32Array(rBuf, 16, rViaCount * 2);
const rPairView = new Int32Array(rBuf, 16 + rViaCount * 8, rPairCount * 2);
let pairCursor = 0;
for (let i = 0; i < sortedVias.length; i++) {
  const via = sortedVias[i]!;
  rViaView[i * 2]     = via;
  rViaView[i * 2 + 1] = pairCursor;
  for (const p of byVia.get(via)!) {
    rPairView[pairCursor * 2]     = p.from;
    rPairView[pairCursor * 2 + 1] = p.to;
    pairCursor++;
  }
}

// Round coords to 5 decimals (~1 m) to keep places.json small.
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const placesOut = places
  .filter((p) => p.lat >= minLat && p.lat <= maxLat && p.lon >= minLng && p.lon <= maxLng)
  .map((p) => ({
    name: p.name, lat: r5(p.lat), lon: r5(p.lon), kind: p.kind,
    ...(p.area ? { area: Math.round(p.area) } : {}),
    ...(p.addr ? { addr: p.addr } : {}),
  }))
  .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
const placeCounts = placesOut.reduce<Record<string, number>>((m, p) => {
  m[p.kind] = (m[p.kind] ?? 0) + 1; return m;
}, {});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'graph.bin'), Buffer.from(ab));
fs.writeFileSync(path.join(OUT_DIR, 'restrictions.bin'), Buffer.from(rBuf));
fs.writeFileSync(path.join(OUT_DIR, 'names.json'), JSON.stringify(names));
fs.writeFileSync(path.join(OUT_DIR, 'places.json'), JSON.stringify(placesOut));
fs.writeFileSync(
  path.join(OUT_DIR, 'meta.json'),
  JSON.stringify({ n, e, rViaCount, rPairCount, bounds: { minLat, maxLat, minLng, maxLng } }, null, 2),
);
fs.copyFileSync(WASM_SRC, path.join(OUT_DIR, 'release.wasm'));

console.log(`\nExported → ${OUT_DIR}`);
console.log(`  graph.bin         ${(total / 1e6).toFixed(1)} MB`);
console.log(`  restrictions.bin  ${(rTotal / 1e3).toFixed(1)} KB  (${rViaCount} via nodes, ${rPairCount} forbidden turns)`);
console.log(`  names.json        ${names.length.toLocaleString()} unique street names`);
console.log(`  places.json       ${placesOut.length.toLocaleString()} places (${Object.entries(placeCounts).map(([k, v]) => `${k}:${v}`).join(', ')})`);
console.log(`  bounds            lat [${minLat.toFixed(4)}, ${maxLat.toFixed(4)}]  lng [${minLng.toFixed(4)}, ${maxLng.toFixed(4)}]`);
console.log(`  release.wasm      copied`);
