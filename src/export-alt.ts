// Offline ALT preprocessing — selects 8 landmarks via farthest-point sampling,
// runs Dijkstra forward and backward from each landmark on free-flow weights,
// and writes web/public/alt.bin.
//
// Binary layout (little-endian):
//
//   Header (16 bytes):
//     [0]  magic  i32 = 0x414C5448 ("ALTH")
//     [4]  n      i32
//     [8]  L      i32  (landmark count)
//     [12] ver    i32  = 1
//
//   landmarks  i32 * L           node index of each landmark
//   fwd        f32 * (L * n)     fwd[l*n + v] = free-flow dist from landmark l to v
//   bwd        f32 * (L * n)     bwd[l*n + v] = free-flow dist from v to landmark l
//                                (= forward Dijkstra on the reverse graph)
//
// Free-flow weight: length × STRETCH[class], where STRETCH[c] = MAX_SPEED / freeFlowKmh[c].
// This matches the CH preprocessing metric.
//
// Run: pnpm export:alt

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ASSUMPTIONS as A } from './lib/traffic-constants.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../web/public');
const OUT = path.join(PUB, 'alt.bin');
const NUM_LANDMARKS = 8;

// ── Load graph.bin ─────────────────────────────────────────────────────────
console.log('Loading graph.bin…');
const rawG = await readFile(path.join(PUB, 'graph.bin')).catch(() => {
  throw new Error('graph.bin not found — run pnpm export:graph first');
});
const ab   = rawG.buffer.slice(rawG.byteOffset, rawG.byteOffset + rawG.byteLength) as ArrayBuffer;
const gHdr = new Int32Array(ab, 0, 4);
if (gHdr[0] !== 0x47524150) throw new Error('bad graph.bin magic');
const n    = gHdr[1]!;
const e    = gHdr[2]!;
const gVer = gHdr[3]!;

const G_HDR  = 16;
const offTgt = G_HDR + 4 * (n + 1);
const offDst = Math.ceil((offTgt + 4 * e) / 8) * 8;
const offLat = offDst + 8 * e;
const offLon = offLat + 8 * n;
const offCls = offLon + 8 * n;

const offsets   = new Int32Array(ab, G_HDR, n + 1);
const targets   = new Int32Array(ab, offTgt, e);
const distances = new Float64Array(ab, offDst, e);
const classes   = new Uint8Array(ab, offCls, e);
// SCC mask (v3+): landmark selection must stay inside the largest SCC —
// a landmark in a disconnected fragment has Infinity to almost every node,
// which both degenerates farthest-point sampling and yields useless bounds.
const offNId = Math.ceil((offCls + e) / 4) * 4;
const offSCC = offNId + 4 * e;
const scc = gVer >= 3 ? new Uint8Array(ab, offSCC, n) : new Uint8Array(n).fill(1);

console.log(`  v${gVer}: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);

// ── Free-flow stretch weights ──────────────────────────────────────────────
const MAX_SPEED = Math.max(...(A.freeFlowKmh as unknown as number[]));
const STRETCH   = (A.freeFlowKmh as unknown as number[]).map(s => MAX_SPEED / s);
const freeFlowW = new Float64Array(e);
for (let ei = 0; ei < e; ei++) {
  freeFlowW[ei] = distances[ei]! * STRETCH[classes[ei]!]!;
}

// ── Build reverse CSR (for backward Dijkstra) ─────────────────────────────
console.log('Building reverse CSR…');
const revDeg = new Int32Array(n);
for (let ei = 0; ei < e; ei++) revDeg[targets[ei]!]++;
const revOff = new Int32Array(n + 1);
for (let i = 0; i < n; i++) revOff[i + 1] = revOff[i]! + revDeg[i]!;
const revTgt = new Int32Array(e);
const revW   = new Float64Array(e);
const pos    = new Int32Array(n);
for (let u = 0; u < n; u++) {
  for (let ei = offsets[u]!; ei < offsets[u + 1]!; ei++) {
    const v = targets[ei]!;
    const k = revOff[v]! + pos[v]!;
    revTgt[k] = u;
    revW[k]   = freeFlowW[ei]!;
    pos[v]++;
  }
}

// ── Lazy Dijkstra on CSR ───────────────────────────────────────────────────
// Pre-allocated heap arrays (reused across Dijkstra runs to avoid GC churn).
const heapN = new Int32Array(e);   // node at heap position i
const heapD = new Float64Array(e); // key at heap position i
let heapSize = 0;

function hPush(node: number, d: number): void {
  let i = heapSize++;
  heapN[i] = node; heapD[i] = d;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapD[p]! <= heapD[i]!) break;
    const tn = heapN[p]!, td = heapD[p]!;
    heapN[p] = heapN[i]!; heapD[p] = heapD[i]!;
    heapN[i] = tn; heapD[i] = td;
    i = p;
  }
}

function hPop(): [number, number] {
  const node = heapN[0]!, d = heapD[0]!;
  const last = --heapSize;
  if (last > 0) {
    heapN[0] = heapN[last]!; heapD[0] = heapD[last]!;
    let i = 0;
    while (true) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < last && heapD[l]! < heapD[m]!) m = l;
      if (r < last && heapD[r]! < heapD[m]!) m = r;
      if (m === i) break;
      const tn = heapN[m]!, td = heapD[m]!;
      heapN[m] = heapN[i]!; heapD[m] = heapD[i]!;
      heapN[i] = tn; heapD[i] = td;
      i = m;
    }
  }
  return [node, d];
}

const dist = new Float64Array(n); // reused per run

function dijkstra(
  src: number,
  off: Int32Array, tgt: Int32Array, w: Float64Array,
): Float32Array {
  dist.fill(Infinity); dist[src] = 0;
  heapSize = 0; hPush(src, 0);
  while (heapSize > 0) {
    const [u, d] = hPop();
    if (d > dist[u]!) continue;
    for (let k = off[u]!; k < off[u + 1]!; k++) {
      const v = tgt[k]!;
      const nd = d + w[k]!;
      if (nd < dist[v]!) { dist[v] = nd; hPush(v, nd); }
    }
  }
  return new Float32Array(dist); // copy + downcast
}

// ── Landmark selection via farthest-point sampling ────────────────────────
console.log(`\nSelecting ${NUM_LANDMARKS} landmarks via farthest-point sampling…`);
const landmarks: number[] = [];
// minReach[v] = min dist from v to any landmark so far (in bwd graph → backward reach)
const minReach = new Float32Array(n).fill(Infinity);

// Bootstrap: seed from an SCC node and take the farthest SCC node actually
// reached. Restricting to the largest SCC (and to finite distances) keeps the
// sampling on the real road network instead of disconnected fragments.
let seed = 0;
while (seed < n && !scc[seed]) seed++;
if (seed === n) throw new Error('no SCC nodes in graph.bin');
const pickFwd = dijkstra(seed, offsets, targets, freeFlowW);
let farthest = seed;
for (let v = 0; v < n; v++) {
  if (scc[v] && Number.isFinite(pickFwd[v]!) && pickFwd[v]! > pickFwd[farthest]!) farthest = v;
}

// The fwd runs for the selected landmarks are saved — they become the fwd data.
const fwdData: Float32Array[] = [];
const bwdData: Float32Array[] = [];

for (let l = 0; l < NUM_LANDMARKS; l++) {
  if (l === 0) {
    landmarks.push(farthest);
  } else {
    // Farthest SCC node from ALL existing landmarks (backward direction).
    // Within the SCC every minReach is finite, so this never degenerates.
    let best = -1, bestD = -1;
    for (let v = 0; v < n; v++) {
      if (!scc[v]) continue;
      const d = minReach[v]!;
      if (Number.isFinite(d) && d > bestD) { bestD = d; best = v; }
    }
    if (best < 0) throw new Error('farthest-point sampling found no reachable SCC candidate');
    landmarks.push(best);
  }

  const lm = landmarks[l]!;
  console.log(`  Landmark ${l}: node ${lm.toLocaleString()}`);

  // Forward Dijkstra from lm
  const t0 = Date.now();
  const fwd = dijkstra(lm, offsets, targets, freeFlowW);
  fwdData.push(fwd);

  // Backward Dijkstra from lm (forward on reverse graph)
  const bwd = dijkstra(lm, revOff, revTgt, revW);
  bwdData.push(bwd);
  console.log(`    fwd+bwd Dijkstra: ${Date.now() - t0} ms`);

  // Update minReach using bwd distances (min backward dist to any landmark)
  for (let v = 0; v < n; v++) {
    if (bwd[v]! < minReach[v]!) minReach[v] = bwd[v]!;
  }
}

// ── Serialize alt.bin ──────────────────────────────────────────────────────
const L = NUM_LANDMARKS;
const offLandmarks = 16;
const offFwd = offLandmarks + 4 * L;
const offBwd = offFwd + 4 * L * n;
const total  = offBwd + 4 * L * n;

const buf = new ArrayBuffer(total);
const hdr = new Int32Array(buf, 0, 4);
hdr[0] = 0x414C5448; // "ALTH"
hdr[1] = n;
hdr[2] = L;
hdr[3] = 1;

const lmArr = new Int32Array(buf, offLandmarks, L);
for (let l = 0; l < L; l++) lmArr[l] = landmarks[l]!;

for (let l = 0; l < L; l++) {
  new Float32Array(buf, offFwd + 4 * l * n, n).set(fwdData[l]!);
  new Float32Array(buf, offBwd + 4 * l * n, n).set(bwdData[l]!);
}

await mkdir(PUB, { recursive: true });
await writeFile(OUT, Buffer.from(buf));

const sizeMB = (total / 1_000_000).toFixed(1);
console.log(`\nWrote ${sizeMB} MB → ${OUT}`);
console.log(`  ${L} landmarks: [${landmarks.join(', ')}]`);
