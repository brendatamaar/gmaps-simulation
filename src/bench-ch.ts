// Validate CH against A* on real Jakarta data, then benchmark. Loads the
// pre-exported graph.bin (no PBF re-parse). Full-city preprocessing in plain TS
// is slow, so by default we validate on a connected BFS sub-region of the real
// road network; pass a node budget to resize it.
//
//   pnpm ch:city            # default region (~50k nodes)
//   pnpm ch:city 120000     # larger region
//   pnpm ch:city full       # whole 927k-node graph (slow preprocessing)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CSR } from './lib/csr.ts';
import { astar } from './lib/astar.ts';
import { fromCSR, preprocess, chQuery, biDijkstra } from './lib/ch.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '../web/public/graph.bin');

// Load the full CSR straight from the exported binary.
function loadCSR(): CSR {
  const buf = fs.readFileSync(BIN);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const hdr = new Int32Array(ab, 0, 4);
  if (hdr[0] !== 0x47524150) throw new Error('bad magic in graph.bin');
  const n = hdr[1]!, e = hdr[2]!;

  const HEADER = 16;
  const offTargets = HEADER + 4 * (n + 1);
  const intsEnd = offTargets + 4 * e;
  const offDist = Math.ceil(intsEnd / 8) * 8;
  const offLats = offDist + 8 * e;
  const offLons = offLats + 8 * n;

  const offsets = new Int32Array(ab, HEADER, n + 1);
  const targets = new Int32Array(ab, offTargets, e);
  const distances = new Float64Array(ab, offDist, e);
  const lats = new Float64Array(ab, offLats, n);
  const lons = new Float64Array(ab, offLons, n);
  // CH benchmark ignores classes/names; empty bands keep the CSR type happy.
  return { n, offsets, targets, distances, classes: new Uint8Array(e),
    nameIds: new Uint32Array(e), names: [''], lats, lons, nodeIds: [], idToIndex: new Map() };
}

// Connected sub-CSR via BFS from a seed, remapped to compact indices.
function subgraph(full: CSR, seed: number, budget: number): CSR {
  const keep: number[] = [];
  const visited = new Uint8Array(full.n);
  const queue = [seed];
  visited[seed] = 1;
  // BFS over out-edges is enough to gather a connected core.
  while (queue.length > 0 && keep.length < budget) {
    const u = queue.shift()!;
    keep.push(u);
    for (let e = full.offsets[u]!; e < full.offsets[u + 1]!; e++) {
      const v = full.targets[e]!;
      if (v !== -1 && !visited[v]) { visited[v] = 1; queue.push(v); }
    }
  }

  const remap = new Map<number, number>();
  keep.forEach((id, i) => remap.set(id, i));
  const m = keep.length;

  const offsets = new Int32Array(m + 1);
  const tgt: number[] = [];
  const dst: number[] = [];
  for (let i = 0; i < m; i++) {
    const u = keep[i]!;
    for (let e = full.offsets[u]!; e < full.offsets[u + 1]!; e++) {
      const v = full.targets[e]!;
      const vi = v === -1 ? undefined : remap.get(v);
      if (vi !== undefined) { tgt.push(vi); dst.push(full.distances[e]!); }
    }
    offsets[i + 1] = tgt.length;
  }
  const lats = new Float64Array(m);
  const lons = new Float64Array(m);
  for (let i = 0; i < m; i++) { lats[i] = full.lats[keep[i]!]!; lons[i] = full.lons[keep[i]!]!; }

  return {
    n: m, offsets, targets: Int32Array.from(tgt), distances: Float64Array.from(dst),
    classes: new Uint8Array(tgt.length), nameIds: new Uint32Array(tgt.length), names: [''],
    lats, lons, nodeIds: keep, idToIndex: remap,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Driver
const arg = process.argv[2] ?? '50000';
const full = loadCSR();
console.log(`Loaded graph.bin: ${full.n.toLocaleString()} nodes, ${full.targets.length.toLocaleString()} edges`);

let csr: CSR;
if (arg === 'full') {
  csr = full;
  console.log('Region: FULL city graph');
} else {
  const budget = parseInt(arg, 10);
  // Seed near the graph's middle index; anywhere with edges yields a connected blob.
  let seed = full.n >> 1;
  while (seed < full.n && full.offsets[seed + 1]! === full.offsets[seed]!) seed++;
  csr = subgraph(full, seed, budget);
  console.log(`Region: BFS sub-graph from node ${seed}, ${csr.n.toLocaleString()} nodes, ${csr.targets.length.toLocaleString()} edges`);
}

console.log('\nBuilding CH graph + preprocessing...');
const ch = fromCSR(csr);
const stats = preprocess(ch, (done, n) => console.log(`  contracted ${done.toLocaleString()}/${n.toLocaleString()}`));
console.log(`  preprocessing: ${(stats.ms / 1000).toFixed(1)} s, ${stats.shortcuts.toLocaleString()} shortcuts added`);

// A*/biDijkstra cost O(graph) per query, so on the full city they're slow and
// we don't need many samples; scale the workload down as the graph grows.
const FULL = csr.n > 200_000;
const PAIRS = FULL ? 60 : 300;        // validation samples
const BENCH = FULL ? 25 : 200;        // timed samples
const REPEATS = FULL ? 1 : 3;

// Correctness: CH must equal A* for many random pairs.
const rng = mulberry32(0xC0FFEE);
const pairs: Array<[number, number]> = [];
while (pairs.length < PAIRS) {
  const s = (rng() * csr.n) | 0, t = (rng() * csr.n) | 0;
  if (s !== t) pairs.push([s, t]);
}

console.log(`\nStep 24 — validating CH vs A* on ${PAIRS} random pairs...`);
let mismatches = 0, reachable = 0;
// Cache each A* result so the benchmark below reuses it instead of recomputing.
const aCache = new Map<string, { dist: number; visited: number } | null>();
for (const [s, t] of pairs) {
  const a = astar(csr, s, t);
  aCache.set(`${s},${t}`, a ? { dist: a.distMeters, visited: a.nodesVisited } : null);
  const c = chQuery(ch, s, t);
  const aDist = a ? a.distMeters : Infinity;
  const cDist = c ? c.dist : Infinity;
  if (aDist === Infinity && cDist === Infinity) continue;
  reachable++;
  if (Math.abs(aDist - cDist) > 1e-3) {
    if (mismatches < 8) console.log(`  MISMATCH ${s}→${t}: A*=${aDist.toFixed(2)} CH=${cDist.toFixed(2)}`);
    mismatches++;
  }
}
console.log(`  reachable pairs: ${reachable}, mismatches: ${mismatches}`);
console.log(mismatches === 0 ? '  CH matches A* exactly' : '  CH DOES NOT MATCH A* — preprocessing/query bug');

// Benchmark A* vs CH (and bidirectional Dijkstra for context).
const benchPairs = pairs.filter(([s, t]) => aCache.get(`${s},${t}`)).slice(0, BENCH);
function timeQueries(fn: (s: number, t: number) => void): { ms: number; per: number } {
  for (const [s, t] of benchPairs) fn(s, t); // warmup
  const t0 = performance.now();
  for (let r = 0; r < REPEATS; r++) for (const [s, t] of benchPairs) fn(s, t);
  const ms = performance.now() - t0;
  return { ms, per: ms / (REPEATS * benchPairs.length) };
}

let aSettled = 0, cSettled = 0;
for (const [s, t] of benchPairs) {
  aSettled += aCache.get(`${s},${t}`)!.visited;
  const c = chQuery(ch, s, t); if (c) cSettled += c.settled;
}
const aTime = timeQueries((s, t) => { astar(csr, s, t); });
const bTime = timeQueries((s, t) => { biDijkstra(ch, s, t); });
const cTime = timeQueries((s, t) => { chQuery(ch, s, t); });

console.log(`\nStep 25 — benchmark over ${benchPairs.length} reachable pairs, ${REPEATS} repeats:`);
console.log('  ┌──────────────────────┬───────────────┬──────────────────┐');
console.log('  │ algorithm            │ avg query     │ avg nodes settled│');
console.log('  ├──────────────────────┼───────────────┼──────────────────┤');
console.log(`  │ A*                   │ ${aTime.per.toFixed(3).padStart(8)} ms   │ ${(aSettled / benchPairs.length).toFixed(0).padStart(12)}     │`);
console.log(`  │ Bidirectional Dijkstra│ ${bTime.per.toFixed(3).padStart(8)} ms   │ ${' '.padStart(12)}     │`);
console.log(`  │ Contraction Hierarchies│ ${cTime.per.toFixed(3).padStart(7)} ms   │ ${(cSettled / benchPairs.length).toFixed(0).padStart(12)}     │`);
console.log('  └──────────────────────┴───────────────┴──────────────────┘');
console.log(`  Preprocessing (one-time): ${(stats.ms / 1000).toFixed(1)} s for ${csr.n.toLocaleString()} nodes`);
console.log(`  CH speedup vs A*: ${(aTime.per / cTime.per).toFixed(1)}×`);
console.log(`  CH explores ${(aSettled / cSettled).toFixed(1)}× fewer nodes than A*`);

process.exit(mismatches === 0 ? 0 : 1);
