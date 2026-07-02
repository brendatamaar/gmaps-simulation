// ============================================================
// Offline CH preprocessing — loads graph.bin, contracts on
// free-flow travel-time weights, writes web/public/ch.bin.
//
// Binary layout (little-endian, SoA, all sections run end-to-end):
//
//   Header (16 bytes):
//     [0]  magic  u32  = 0x43484720 ("CHG ")
//     [4]  n      i32  (node count)
//     [8]  E      i32  (total out-edges = original + shortcuts)
//     [12] ver    i32  = 1
//
//   rank[0..n-1]     i32 * n      — contraction rank per node
//   outOff[0..n]     i32 * (n+1) — CSR offsets into flat edge list
//   edgeTo[0..E-1]   i32 * E     — destination node
//   edgeMid[0..E-1]  i32 * E     — bypass node (-1 = original road edge)
//   edgeCa[0..E-1]   i32 * E     — first child edge index (-1 if original)
//   edgeCb[0..E-1]   i32 * E     — second child edge index
//   <pad to 8-byte boundary>
//   edgeW[0..E-1]    f64 * E     — free-flow travel time (metres-equivalent)
//
// Free-flow weight: length × STRETCH[class]
//   STRETCH[c] = MAX_SPEED_KMH / freeFlowKmh[c]
//   ETA = Σweight / MAX_SPEED_MPS  (same units as A* traffic.ts weights)
//
// Run: pnpm export:ch
// ============================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { fromCSR, preprocess } from './lib/ch.ts';
import { ASSUMPTIONS as A } from './lib/traffic-constants.ts';
import type { CHEdge } from './lib/ch.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../web/public');
const OUT = path.join(PUB, 'ch.bin');

// ── Load graph.bin ─────────────────────────────────────────────
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
if (gVer < 1) throw new Error('graph.bin too old — re-run pnpm export:graph');

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

console.log(`  v${gVer}: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);

// ── Free-flow stretch factors ──────────────────────────────────
// STRETCH[c] = MAX_SPEED / freeFlowKmh[c].  ETA = Σ(length × STRETCH) / MAX_SPEED_MPS.
const MAX_SPEED = Math.max(...(A.freeFlowKmh as unknown as number[]));  // 100 km/h
const STRETCH   = (A.freeFlowKmh as unknown as number[]).map(s => MAX_SPEED / s);

// ── Build CH graph ─────────────────────────────────────────────
console.log('\nBuilding CH graph with free-flow weights…');
const g = fromCSR(
  { n, offsets, targets, distances },
  (ei) => distances[ei]! * STRETCH[classes[ei]!]!,
);

// ── Preprocess ─────────────────────────────────────────────────
console.log('Preprocessing (lazy edge-difference ordering)…');
const preprocessStart = performance.now();

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function renderBar(done: number, total: number, width = 30): string {
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

// Track last known progress so the timer can redraw between contraction ticks.
let lastDone = 0, lastTotal = n;

function redraw(done: number, total: number): void {
  const elapsedMs = performance.now() - preprocessStart;
  const rate      = done > 0 ? done / (elapsedMs / 1000) : 0;
  const etaMs     = rate > 0 ? ((total - done) / rate) * 1000 : 0;
  const pct       = ((done / total) * 100).toFixed(1);
  const bar       = renderBar(done, total);
  const etaPart   = done < total ? `  ETA ~${fmtDuration(etaMs)}` : '';
  process.stdout.write(
    `\r  ${bar} ${pct}%  ${done.toLocaleString()}/${total.toLocaleString()}` +
    `  ${fmtDuration(elapsedMs)} elapsed${etaPart}  ${Math.round(rate).toLocaleString()} nodes/s  `,
  );
}

// Tick every second so the display never freezes even when contractions slow down.
const ticker = setInterval(() => redraw(lastDone, lastTotal), 1000);

const stats = preprocess(g, (done, total) => {
  lastDone = done; lastTotal = total;
  redraw(done, total);
});

clearInterval(ticker);
const totalMs = performance.now() - preprocessStart;
process.stdout.write('\n');
console.log(`  Done: ${stats.shortcuts.toLocaleString()} shortcuts in ${fmtDuration(totalMs)}`);

// ── Assign flat indices to all out-edges ───────────────────────
// We walk g.out[u] for every u in node order; each CHEdge gets a stable index.
// ca/cb of shortcuts reference other CHEdge objects in g.out, so we can look
// them up via the same map.
const edgeIdxMap = new Map<CHEdge, number>();
let E = 0;
for (let u = 0; u < n; u++) {
  for (const edge of g.out[u]!) {
    edgeIdxMap.set(edge, E++);
  }
}
console.log(`\nEdge counts: ${e.toLocaleString()} original + ${(E - e).toLocaleString()} shortcuts = ${E.toLocaleString()} total`);

// ── Compute binary offsets ─────────────────────────────────────
const offRank   = 16;
const offOutOff = offRank   + 4 * n;
const offTo     = offOutOff + 4 * (n + 1);
const offMid    = offTo     + 4 * E;
const offCa     = offMid    + 4 * E;
const offCb     = offCa     + 4 * E;
const offW      = Math.ceil((offCb + 4 * E) / 8) * 8;  // align f64
const totalSize = offW + 8 * E;

// ── Serialize ─────────────────────────────────────────────────
const buf    = new ArrayBuffer(totalSize);
const hdr    = new Int32Array(buf, 0, 4);
const rank   = new Int32Array(buf, offRank,   n);
const outOff = new Int32Array(buf, offOutOff, n + 1);
const edgeTo = new Int32Array(buf, offTo,  E);
const edgeMid = new Int32Array(buf, offMid, E);
const edgeCa  = new Int32Array(buf, offCa,  E);
const edgeCb  = new Int32Array(buf, offCb,  E);
const edgeW   = new Float64Array(buf, offW, E);

hdr[0] = 0x43484720;  // "CHG "
hdr[1] = n;
hdr[2] = E;
hdr[3] = 1;

for (let u = 0; u < n; u++) rank[u] = g.rank[u]!;

let ei = 0;
for (let u = 0; u < n; u++) {
  outOff[u] = ei;
  for (const edge of g.out[u]!) {
    edgeTo[ei]  = edge.to;
    edgeMid[ei] = edge.mid;
    edgeCa[ei]  = edge.ca !== null ? (edgeIdxMap.get(edge.ca) ?? -1) : -1;
    edgeCb[ei]  = edge.cb !== null ? (edgeIdxMap.get(edge.cb) ?? -1) : -1;
    edgeW[ei]   = edge.weight;
    ei++;
  }
}
outOff[n] = E;

await mkdir(PUB, { recursive: true });
await writeFile(OUT, Buffer.from(buf));

const sizeMB = (totalSize / 1_000_000).toFixed(1);
console.log(`\nWrote ${sizeMB} MB → ${OUT}`);
console.log(`  n=${n.toLocaleString()}, E=${E.toLocaleString()}, shortcuts=${stats.shortcuts.toLocaleString()}`);
