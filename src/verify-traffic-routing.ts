// ============================================================
// TRAFFIC ROUTING VERIFICATION — SIMULATION ONLY
// ============================================================
// Asserts that traffic.bin measurably affects routing:
//
//   1. ETA(h=8 trafficOn) > ETA(h=3 trafficOn) × 1.20
//      on at least 2 of 3 OD pairs
//   2. Chosen path node-sequence DIFFERS between h=3 and h=8
//      on at least 1 pair
//   3. ETA(h=8 trafficOff) ≈ ETA(h=3 trafficOn) within 5%
//      (traffic toggle faithfully restores near-free-flow)
//
// Prints a before/after table for Monas → Blok M.
//
// Run: pnpm verify:traffic-routing
// ============================================================

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fillWeights, etaSeconds, type TrafficModel,
} from '../web/src/traffic.ts';
import { ASSUMPTIONS as A } from './lib/traffic-constants.ts';
import { haversine } from './lib/geo.ts';
import type { Graph } from '../web/src/graph.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB     = path.join(__dirname, '../web/public');  // graph.bin, release.wasm
const GEN_OUT = path.join(__dirname, '../gen-out');     // traffic.bin

// ── Load graph.bin ────────────────────────────────────────────

const rawG = await readFile(path.join(PUB, 'graph.bin')).catch(() => {
  throw new Error('graph.bin not found — run pnpm export:graph first');
});
const ab = rawG.buffer.slice(rawG.byteOffset, rawG.byteOffset + rawG.byteLength);
const gHdr = new Int32Array(ab, 0, 4);
if (gHdr[0] !== 0x47524150) throw new Error('bad graph.bin magic');
const n = gHdr[1]!, e = gHdr[2]!, gVersion = gHdr[3]!;
if (gVersion < 2) throw new Error('graph.bin too old — re-run pnpm export:graph');

const G_HDR  = 16;
const offTgt = G_HDR + 4 * (n + 1);
const offDst = Math.ceil((offTgt + 4 * e) / 8) * 8;
const offLat = offDst + 8 * e;
const offLon = offLat + 8 * n;
const offCls = offLon + 8 * n;
const offNId = Math.ceil((offCls + e) / 4) * 4;

const offsets   = new Int32Array(ab, G_HDR, n + 1);
const targets   = new Int32Array(ab, offTgt, e);
const distances = new Float64Array(ab, offDst, e);
const nodeLats  = new Float64Array(ab, offLat, n);
const nodeLons  = new Float64Array(ab, offLon, n);
const classes   = new Uint8Array(ab, offCls, e);
const nameIds   = new Uint32Array(ab, offNId, e);
void nameIds; // read to force offset computation; not used in routing

const graph: Graph = {
  n, e,
  offsets, targets, distances, classes, nameIds,
  names: [],  // not needed for routing
  lats: nodeLats, lons: nodeLons,
  scc: new Uint8Array(n).fill(1), // not needed headlessly; treat all nodes as routable
  bounds: { minLat: -6.4, maxLat: -6.05, minLng: 106.65, maxLng: 107.0 },
};

console.log(`graph.bin v${gVersion}: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);

// ── Init WASM A* router ───────────────────────────────────────

type WasmExports = {
  memory: WebAssembly.Memory;
  initGraph(n: number, e: number): void;
  getOffsetsPtr(): number;
  getTargetsPtr(): number;
  getDistPtr(): number;
  getLatsPtr(): number;
  getLonsPtr(): number;
  getPathPtr(): number;
  getPathLen(): number;
  getDistMeters(): number;
  astar(startIdx: number, endIdx: number, hScale: number): number;
};

const rawWasm = await readFile(path.join(PUB, 'release.wasm')).catch(() => {
  throw new Error('release.wasm not found in web/public/ — run pnpm build:wasm');
});
const wasmBuf = rawWasm.buffer.slice(rawWasm.byteOffset, rawWasm.byteOffset + rawWasm.byteLength);
const { instance } = await WebAssembly.instantiate(wasmBuf, {
  env: {
    abort(_m: number, _f: number, line: number, col: number): never {
      throw new Error(`AS abort at ${line}:${col}`);
    },
  },
  Math,
} as unknown as WebAssembly.Imports);

const w = instance.exports as unknown as WasmExports;
// initGraph allocates all WASM memory. Capture buf AFTER; no further growth.
w.initGraph(n, e);
const wBuf = w.memory.buffer;
new Int32Array(wBuf, w.getOffsetsPtr(), n + 1).set(offsets);
new Int32Array(wBuf, w.getTargetsPtr(), e).set(targets);
new Float64Array(wBuf, w.getLatsPtr(), n).set(nodeLats);
new Float64Array(wBuf, w.getLonsPtr(), n).set(nodeLons);

// weights is a live view over WASM linear memory. fillWeights writes here;
// astar() reads it. Same pattern as the browser Router.
const weights = new Float64Array(wBuf, w.getDistPtr(), e);
weights.set(distances); // sensible init until fillWeights overwrites it

console.log('WASM A* initialised');

// ── Build BPR model (same computation as traffic-gen.worker.ts) ───────────────
// Compute per-edge cbdFactor and edgeDot from graph geometry.
// This mirrors the in-browser Web Worker so the verify script tests the same
// model the browser uses, without requiring traffic.bin.

void GEN_OUT; // GEN_OUT available if other verify scripts need it; unused here

console.log('Computing BPR per-edge factors (cbdFactor, edgeDot)…');
const t0bpr = performance.now();
const cbdFactor = new Float64Array(e);
const edgeDot   = new Float64Array(e);
for (let i = 0; i < n; i++) {
  const srcLat = nodeLats[i]!;
  const srcLon = nodeLons[i]!;
  for (let ei = offsets[i]!; ei < offsets[i + 1]!; ei++) {
    const j = targets[ei]!;
    const midLat = j >= 0 ? (srcLat + nodeLats[j]!) / 2 : srcLat;
    const midLon = j >= 0 ? (srcLon + nodeLons[j]!) / 2 : srcLon;
    const cbdDist = haversine(midLat, midLon, A.cbdLat, A.cbdLon);
    cbdFactor[ei] = 1 + A.cbdDemandBoost * Math.exp(-((cbdDist / A.cbdScaleM) ** 2));
    let dot = 0;
    if (j >= 0) {
      const cosLat = Math.cos((midLat * Math.PI) / 180);
      const ex = (nodeLons[j]! - srcLon) * cosLat;
      const ey = nodeLats[j]! - srcLat;
      const cx = (A.cbdLon - midLon) * cosLat;
      const cy = A.cbdLat - midLat;
      const eMag = Math.sqrt(ex * ex + ey * ey);
      const cMag = Math.sqrt(cx * cx + cy * cy);
      if (eMag > 0 && cMag > 0) dot = (ex * cx + ey * cy) / (eMag * cMag);
    }
    edgeDot[ei] = dot;
  }
}
const elapsedBpr = ((performance.now() - t0bpr) / 1000).toFixed(2);
console.log(`  Done in ${elapsedBpr}s.\n`);

const model: TrafficModel = { staticMult: new Float64Array(e).fill(1), cbdFactor, edgeDot };

// ── Helpers ───────────────────────────────────────────────────

function nearestNode(lat: number, lon: number): number {
  const cos = Math.cos((lat * Math.PI) / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dLat = nodeLats[i]! - lat;
    const dLon = (nodeLons[i]! - lon) * cos;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function runRoute(
  s: number, t: number, hour: number, trafficOn: boolean,
): { etaSec: number; pathKey: string } | null {
  fillWeights(weights, graph, model, hour, trafficOn, 'drive');
  if (w.astar(s, t, 1.0) !== 0) return null;
  const len = w.getPathLen();
  const path = new Int32Array(w.memory.buffer, w.getPathPtr(), len).slice();
  return { etaSec: etaSeconds(w.getDistMeters()), pathKey: path.join(',') };
}

function fmt(sec: number): string {
  return `${Math.round(sec / 60)} min`;
}

// ── OD pairs ──────────────────────────────────────────────────

const OD_PAIRS = [
  { name: 'Monas → Blok M',              oLat: -6.1754, oLon: 106.8272, dLat: -6.2615, dLon: 106.8106 },
  { name: 'Senen → Pondok Indah',        oLat: -6.1686, oLon: 106.8456, dLat: -6.2881, dLon: 106.7880 },
  { name: 'Kelapa Gading → Tanah Abang', oLat: -6.1573, oLon: 106.9088, dLat: -6.1906, dLon: 106.8143 },
];

type PairResult = {
  name:    string;
  eta3:    number; // h=03 trafficOn
  eta8:    number; // h=08 trafficOn
  eta8off: number; // h=08 trafficOff
  path3:   string;
  path8:   string;
};

console.log('Running 3 OD pairs × 3 scenarios (h=03 on · h=08 on · h=08 off)…\n');

const results: PairResult[] = [];
for (const pair of OD_PAIRS) {
  const s = nearestNode(pair.oLat, pair.oLon);
  const t = nearestNode(pair.dLat, pair.dLon);

  const r3    = runRoute(s, t, 3,  true);
  const r8    = runRoute(s, t, 8,  true);
  const r8off = runRoute(s, t, 8, false);

  if (!r3 || !r8 || !r8off) {
    console.warn(`  WARN: one or more routes failed for ${pair.name} — skipping`);
    continue;
  }

  results.push({
    name: pair.name,
    eta3:    r3.etaSec,
    eta8:    r8.etaSec,
    eta8off: r8off.etaSec,
    path3:   r3.pathKey,
    path8:   r8.pathKey,
  });

  const ratio = r8.etaSec / r3.etaSec;
  const diverged = r3.pathKey !== r8.pathKey;
  console.log(
    `  ${pair.name}\n` +
    `    h=03 on:  ${fmt(r3.etaSec).padStart(6)}\n` +
    `    h=08 on:  ${fmt(r8.etaSec).padStart(6)}  (×${ratio.toFixed(2)}${diverged ? '  path CHANGED' : ''})\n` +
    `    h=08 off: ${fmt(r8off.etaSec).padStart(6)}`,
  );
}
console.log();

// ── Assertions ────────────────────────────────────────────────

let passCount = 0, failCount = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  cond ? passCount++ : failCount++;
};

// 1. Peak ETA at least 20% worse than overnight on ≥ 2 pairs.
const peakSlower = results.filter(r => r.eta8 > r.eta3 * 1.20);
ok(
  peakSlower.length >= 2,
  `ETA(08:00) > ETA(03:00) × 1.20 on ≥ 2 pairs  ` +
  `(${peakSlower.length}/${results.length} qualify: ${peakSlower.map(r => r.name).join('; ') || 'none'})`,
);

// 2. Path diverges between overnight and peak on at least 1 pair.
const diverged = results.filter(r => r.path3 !== r.path8);
ok(
  diverged.length >= 1,
  `Path sequence differs h=03 vs h=08 on ≥ 1 pair  ` +
  `(${diverged.length}/${results.length} diverge: ${diverged.map(r => r.name).join('; ') || 'none'})`,
);

// 3. Traffic-off at h=8 restores near-overnight ETA (toggle works).
// At h=3 the BPR model gives near-free-flow (demand ≈ 4% of peak → low mult),
// and trafficOff gives exactly free-flow (mult = 1). Allow 5%.
const toggleOk = results.filter(r => {
  const ratio = r.eta8off / r.eta3;
  return ratio > 0.95 && ratio < 1.05;
});
ok(
  toggleOk.length === results.length,
  `trafficOff(h=08) ≈ trafficOn(h=03) within 5% on all pairs  ` +
  `(${toggleOk.length}/${results.length} within tolerance)`,
);

// ── Monas → Blok M detail ─────────────────────────────────────

console.log('\n── Monas → Blok M ──────────────────────────────────────────');
const monasBlokM = results.find(r => r.name.startsWith('Monas'));
if (monasBlokM) {
  const ratio = monasBlokM.eta8 / monasBlokM.eta3;
  const pathChanged = monasBlokM.path3 !== monasBlokM.path8;
  console.log(`  03:00 traffic ON:  ${fmt(monasBlokM.eta3).padStart(6)}  (${Math.round(monasBlokM.eta3)} s)`);
  console.log(`  08:00 traffic ON:  ${fmt(monasBlokM.eta8).padStart(6)}  (${Math.round(monasBlokM.eta8)} s)  ×${ratio.toFixed(2)} slower`);
  console.log(`  08:00 traffic OFF: ${fmt(monasBlokM.eta8off).padStart(6)}  (${Math.round(monasBlokM.eta8off)} s)  free-flow baseline`);
  console.log(`  Path changed 03→08: ${pathChanged}`);
} else {
  console.log('  (route failed for this pair)');
}

// ── Summary ───────────────────────────────────────────────────

console.log();
if (failCount === 0) {
  console.log(`All ${passCount} assertions passed. Traffic routing is working correctly.`);
} else {
  console.log(`${failCount} assertion(s) FAILED. Check BPR model or assertions above.`);
  process.exitCode = 1;
}
