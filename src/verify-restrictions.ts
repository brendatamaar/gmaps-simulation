// ============================================================
// TURN-RESTRICTION ROUTING VERIFICATION
// ============================================================
// Proves the load-time restriction split (web/src/restriction-split.ts) makes
// the node-based routers exactly correct under turn restrictions:
//
//   reference — edge-based A* on the ORIGINAL graph (search state = edge, so
//               restrictions are handled exactly by construction)
//   wasm      — node-based WASM A* on the SPLIT graph
//   bidir     — bidirectional A* on the SPLIT graph (Dijkstra and, when
//               alt.bin is present, ALT — which also exercises the balanced-
//               potential termination fix)
//
// All three must agree on cost for every query, and no returned path may
// contain a forbidden turn. Query sets:
//   A. every restriction pair (from → to through its via)
//   B. destinations ON restricted via nodes (exercises the arrival remap)
//   C. seeded random pairs across the largest SCC
//   D. subset of A re-run with traffic-on fallback weights
//
// Run: pnpm verify:restrictions
// ============================================================

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MinHeap } from './lib/heap.ts';
import { haversine } from './lib/geo.ts';
import type { Graph } from '../web/src/graph.ts';
import { isForbidden, type Restrictions } from '../web/src/router.ts';
import { applyRestrictionSplit } from '../web/src/restriction-split.ts';
import { bidirRoute, buildRevCSR } from '../web/src/bidir-router.ts';
import { precompute, fillWeights } from '../web/src/traffic.ts';
import type { AltData } from '../web/src/alt.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../web/public');

// ── Load graph.bin (mirror of web/src/graph.ts) ───────────────

const rawG = await readFile(path.join(PUB, 'graph.bin'));
const ab = rawG.buffer.slice(rawG.byteOffset, rawG.byteOffset + rawG.byteLength) as ArrayBuffer;
const hdr = new Int32Array(ab, 0, 4);
if (hdr[0] !== 0x47524150) throw new Error('bad graph.bin magic');
const n = hdr[1]!, e = hdr[2]!, version = hdr[3]!;
if (version < 2) throw new Error('graph.bin too old — re-run pnpm export:graph');
const HEADER = 16;
const offTargets = HEADER + 4 * (n + 1);
const offDist = Math.ceil((offTargets + 4 * e) / 8) * 8;
const offLats = offDist + 8 * e;
const offLons = offLats + 8 * n;
const offClasses = offLons + 8 * n;
const offNameIds = Math.ceil((offClasses + e) / 4) * 4;
const offSCC = offNameIds + 4 * e;

const graphO: Graph = {
  n, e,
  offsets: new Int32Array(ab, HEADER, n + 1),
  targets: new Int32Array(ab, offTargets, e),
  distances: new Float64Array(ab, offDist, e),
  classes: new Uint8Array(ab, offClasses, e),
  nameIds: new Uint32Array(ab, offNameIds, e),
  names: [],
  lats: new Float64Array(ab, offLats, n),
  lons: new Float64Array(ab, offLons, n),
  scc: version >= 3 ? new Uint8Array(ab, offSCC, n) : new Uint8Array(n).fill(1),
  bounds: { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 },
};
console.log(`graph.bin v${version}: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);

// ── Load restrictions.bin (mirror of web/src/router.ts) ───────

const rawR = await readFile(path.join(PUB, 'restrictions.bin'));
const rab = rawR.buffer.slice(rawR.byteOffset, rawR.byteOffset + rawR.byteLength) as ArrayBuffer;
const rHdr = new Uint32Array(rab, 0, 4);
if (rHdr[0] !== 0x52455354) throw new Error('bad restrictions.bin magic');
const viaCount = rHdr[2]!, pairCount = rHdr[3]!;
const viaSection = new Int32Array(rab, 16, viaCount * 2);
const viaNodes = new Int32Array(viaCount);
const pairOffs = new Int32Array(viaCount);
for (let i = 0; i < viaCount; i++) { viaNodes[i] = viaSection[i * 2]!; pairOffs[i] = viaSection[i * 2 + 1]!; }
const restrictions: Restrictions = {
  viaCount, pairCount, viaNodes, pairOffs,
  pairs: new Int32Array(rab, 16 + viaCount * 8, pairCount * 2),
};
console.log(`restrictions.bin: ${viaCount} vias, ${pairCount} forbidden turns`);

// ── Split graph ────────────────────────────────────────────────

const split = applyRestrictionSplit(graphO, restrictions)!;
const graphS = split.graph;
console.log(`split graph: ${graphS.n.toLocaleString()} nodes (+${graphS.n - n}), ${graphS.e.toLocaleString()} edges (+${graphS.e - e})`);

// ── Load alt.bin if present (mirror of web/src/alt.ts) ────────

let altData: AltData | null = null;
try {
  const rawA = await readFile(path.join(PUB, 'alt.bin'));
  const aab = rawA.buffer.slice(rawA.byteOffset, rawA.byteOffset + rawA.byteLength) as ArrayBuffer;
  const aHdr = new Int32Array(aab, 0, 4);
  if (aHdr[0] !== 0x414C5448) throw new Error('bad alt.bin magic');
  const an = aHdr[1]!, L = aHdr[2]!;
  const offLandmarks = 16;
  const offFwd = offLandmarks + 4 * L;
  const offBwd = offFwd + 4 * L * an;
  const fwd: Float32Array[] = [], bwd: Float32Array[] = [];
  for (let l = 0; l < L; l++) {
    fwd.push(new Float32Array(aab, offFwd + 4 * l * an, an));
    bwd.push(new Float32Array(aab, offBwd + 4 * l * an, an));
  }
  altData = { n: an, L, landmarks: new Int32Array(aab, offLandmarks, L), fwd, bwd, remap: split.altRemap };
  console.log(`alt.bin: ${L} landmarks (ALT variant enabled)`);
} catch {
  console.log('alt.bin not found — skipping ALT variant');
}

// ── WASM A* on the split graph ─────────────────────────────────

type WExports = {
  memory: WebAssembly.Memory;
  initGraph(n: number, e: number): void;
  getOffsetsPtr(): number; getTargetsPtr(): number; getDistPtr(): number;
  getLatsPtr(): number; getLonsPtr(): number;
  getPathPtr(): number; getPathLen(): number; getDistMeters(): number;
  astar(s: number, t: number, hScale: number): number;
};
const rawWasm = await readFile(path.join(PUB, 'release.wasm'));
const wasmBuf = rawWasm.buffer.slice(rawWasm.byteOffset, rawWasm.byteOffset + rawWasm.byteLength);
const { instance } = await WebAssembly.instantiate(wasmBuf, {
  env: { abort(_m: number, _f: number, l: number, c: number): never { throw new Error(`AS abort ${l}:${c}`); } },
  Math,
} as unknown as WebAssembly.Imports);
const w = instance.exports as unknown as WExports;
w.initGraph(graphS.n, graphS.e);
const wBuf = w.memory.buffer;
new Int32Array(wBuf, w.getOffsetsPtr(), graphS.n + 1).set(graphS.offsets);
new Int32Array(wBuf, w.getTargetsPtr(), graphS.e).set(graphS.targets);
new Float64Array(wBuf, w.getLatsPtr(), graphS.n).set(graphS.lats);
new Float64Array(wBuf, w.getLonsPtr(), graphS.n).set(graphS.lons);
const weightsS = new Float64Array(wBuf, w.getDistPtr(), graphS.e);

// ── Weights (free-flow drive metric, matching ALT preprocessing) ──

const modelO = precompute(graphO);
const modelS = precompute(graphS);
const weightsO = new Float64Array(e);

// ── Reference: exact edge-based A* on the original graph ──────

const edgeFrom = new Int32Array(e);
for (let u = 0; u < n; u++) {
  for (let ei = graphO.offsets[u]!; ei < graphO.offsets[u + 1]!; ei++) edgeFrom[ei] = u;
}
const refD = new Float64Array(e);
const refStamp = new Int32Array(e);
const refClosed = new Int32Array(e);
let refVer = 0;

function refCost(s: number, t: number, wts: Float64Array): number | null {
  if (s === t) return 0;
  const ver = ++refVer;
  const { offsets, targets, lats, lons } = graphO;
  const tLat = lats[t]!, tLon = lons[t]!;
  const h = (v: number) => haversine(lats[v]!, lons[v]!, tLat, tLon);
  const heap = new MinHeap();
  for (let ei = offsets[s]!; ei < offsets[s + 1]!; ei++) {
    const c = wts[ei]!;
    if (refStamp[ei] !== ver || c < refD[ei]!) {
      refD[ei] = c; refStamp[ei] = ver;
      heap.push(ei, c + h(targets[ei]!));
    }
  }
  while (heap.size > 0) {
    const { node: ei } = heap.pop()!;
    if (refClosed[ei] === ver) continue;
    refClosed[ei] = ver;
    const d = refD[ei]!;
    const v = targets[ei]!;
    if (v === t) return d;
    const prev = edgeFrom[ei]!;
    for (let e2 = offsets[v]!; e2 < offsets[v + 1]!; e2++) {
      if (isForbidden(restrictions, prev, v, targets[e2]!)) continue;
      const nd = d + wts[e2]!;
      if (refStamp[e2] !== ver || nd < refD[e2]!) {
        refD[e2] = nd; refStamp[e2] = ver;
        heap.push(e2, nd + h(targets[e2]!));
      }
    }
  }
  return null;
}

// ── Runners on the split graph ─────────────────────────────────

function wasmCost(s: number, t: number): { cost: number | null; path: Int32Array | null } {
  if (w.astar(s, t, 1.0) !== 0) return { cost: null, path: null };
  const len = w.getPathLen();
  return { cost: w.getDistMeters(), path: new Int32Array(w.memory.buffer, w.getPathPtr(), len).slice() };
}

const rev = buildRevCSR(graphS);
function bidirCost(s: number, t: number, alt: AltData | null): { cost: number | null; path: Int32Array | null } {
  const r = bidirRoute(graphS, rev, weightsS, alt, null, s, t);
  return r ? { cost: r.cost, path: r.path } : { cost: null, path: null };
}

// A returned split-graph path, mapped back to physical node ids, must contain
// no forbidden turn.
function pathLegal(p: Int32Array): boolean {
  const phys: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const id = split.altRemap[p[i]!]!;
    if (phys.length === 0 || phys[phys.length - 1] !== id) phys.push(id);
  }
  for (let i = 1; i < phys.length - 1; i++) {
    if (isForbidden(restrictions, phys[i - 1]!, phys[i]!, phys[i + 1]!)) return false;
  }
  return true;
}

// ── Query sets ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}
const rand = mulberry32(0xC0FFEE);
const sccNodes: number[] = [];
for (let i = 0; i < n; i++) if (graphO.scc[i]) sccNodes.push(i);
const randScc = () => sccNodes[Math.floor(rand() * sccNodes.length)]!;

type Q = { s: number; t: number; tag: string };
const queries: Q[] = [];
// A: every forbidden (from → to) pair routed directly.
for (let vi = 0; vi < viaCount; vi++) {
  const pStart = pairOffs[vi]!;
  const pEnd = vi < viaCount - 1 ? pairOffs[vi + 1]! : pairCount;
  for (let pi = pStart; pi < pEnd; pi++) {
    queries.push({ s: restrictions.pairs[pi * 2]!, t: restrictions.pairs[pi * 2 + 1]!, tag: 'pair' });
  }
}
// B: random origin → restricted via node (arrival remap). Long queries — the
// JS edge-based reference is the bottleneck, so keep the count modest.
for (let vi = 0; vi < Math.min(viaCount, 15); vi++) {
  queries.push({ s: randScc(), t: viaNodes[Math.floor(rand() * viaCount)]!, tag: 'via-dest' });
}
// C: random pairs (long queries, same cost consideration).
for (let i = 0; i < 15; i++) queries.push({ s: randScc(), t: randScc(), tag: 'random' });

// Pairs with an endpoint outside the largest SCC are usually unreachable, and
// every router degrades to an exhaustive full-graph sweep before concluding
// "no route" (~5-15 s per query). The app never routes such endpoints (it
// snaps to the SCC), so keep a handful as no-path spot checks and skip the rest.
const NO_PATH_SPOT_CHECKS = 5;
let offScc = 0;
const runQueries = queries.filter(q =>
  (graphO.scc[q.s]! && graphO.scc[q.t]!) || ++offScc <= NO_PATH_SPOT_CHECKS,
);
if (offScc > NO_PATH_SPOT_CHECKS) {
  console.log(`(${offScc} queries have endpoints outside the largest SCC — keeping ${NO_PATH_SPOT_CHECKS} as no-path spot checks, skipping ${offScc - NO_PATH_SPOT_CHECKS})`);
}

// ── Restriction-aware reachability (cheap no-path confirmation) ────
// The exact edge-based reference degenerates to an exhaustive full-graph
// sweep (with a haversine per relaxation) when no legal path exists — tens of
// seconds per query in JS. But reachability doesn't depend on weights: an
// unweighted BFS over the same edge-states (edge = state, restriction-checked
// transitions) answers "does any legal path exist" exactly, in ~1 s. When it
// says unreachable, ref = null is certain and the weighted sweep is skipped.

const rrSeen = new Int32Array(e);
const rrQueue = new Int32Array(e);
let rrVer = 0;

function restrictedReachable(s: number, t: number): boolean {
  if (s === t) return true;
  const ver = ++rrVer;
  const { offsets, targets } = graphO;
  let head = 0, tail = 0;
  for (let ei = offsets[s]!; ei < offsets[s + 1]!; ei++) { rrSeen[ei] = ver; rrQueue[tail++] = ei; }
  while (head < tail) {
    const ei = rrQueue[head++]!;
    const v = targets[ei]!;
    if (v === t) return true;
    if (v < 0) continue;
    const prev = edgeFrom[ei]!;
    for (let e2 = offsets[v]!; e2 < offsets[v + 1]!; e2++) {
      if (rrSeen[e2] === ver) continue;
      if (isForbidden(restrictions, prev, v, targets[e2]!)) continue;
      rrSeen[e2] = ver; rrQueue[tail++] = e2;
    }
  }
  return false;
}

// ── Run ────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures: string[] = [];
const REL = 1e-6;
const close = (a: number, b: number) => Math.abs(a - b) <= REL * Math.max(1, Math.abs(a), Math.abs(b));

// Same-line progress ticker so a manual run visibly stays alive. Falls back
// to ordinary lines when stdout is not a TTY (piped/redirected).
const tty = process.stdout.isTTY === true;
function tick(label: string, done: number, total: number, t0: number, lastMs: number) {
  const el = ((performance.now() - t0) / 1000).toFixed(0);
  const slow = lastMs > 5000 ? `  (last query ${(lastMs / 1000).toFixed(1)}s — likely no-path exhaustive search)` : '';
  const line = `  ${label}: ${done}/${total}  [${el}s elapsed]${slow}`;
  if (tty) process.stdout.write(`\r${line.padEnd(100)}${done === total ? '\n' : ''}`);
  else if (done % 25 === 0 || done === total || lastMs > 5000) console.log(line);
}

function runSet(label: string, qs: Q[], trafficOn: boolean) {
  fillWeights(weightsO, graphO, modelO, 8, trafficOn, 'drive');
  fillWeights(weightsS, graphS, modelS, 8, trafficOn, 'drive');
  const t0 = performance.now();
  let done = 0;
  for (const q of qs) {
    const tq0 = performance.now();
    const tSplit = split.arrivalOf.get(q.t) ?? q.t;
    const wa = wasmCost(q.s, tSplit);
    const bd = bidirCost(q.s, tSplit, null);
    const ba = altData ? bidirCost(q.s, tSplit, altData) : null;

    // Reference last, and only when it can terminate quickly: with a path it
    // stops at the target settle; when the restriction-aware BFS proves no
    // legal path exists, ref = null without the weighted sweep. The exhaustive
    // sweep only remains when the routers found nothing but a legal path DOES
    // exist — i.e. a genuine router bug, where we want the exact cost anyway.
    let ref: number | null;
    const anyFound = wa.cost !== null || bd.cost !== null || (ba !== null && ba.cost !== null);
    if (anyFound || restrictedReachable(q.s, q.t)) {
      ref = refCost(q.s, q.t, weightsO);
    } else {
      ref = null;
    }

    const results: Array<[string, number | null, Int32Array | null]> = [
      ['wasm', wa.cost, wa.path],
      ['bidir', bd.cost, bd.path],
    ];
    if (ba) results.push(['bidir+alt', ba.cost, ba.path]);

    let ok = true;
    for (const [name, cost, p] of results) {
      if (ref === null ? cost !== null : cost === null || !close(ref, cost)) {
        ok = false;
        failures.push(`${label} ${q.tag} ${q.s}→${q.t}: ref=${ref?.toFixed(3) ?? 'null'} ${name}=${cost?.toFixed(3) ?? 'null'}`);
      } else if (p && !pathLegal(p)) {
        ok = false;
        failures.push(`${label} ${q.tag} ${q.s}→${q.t}: ${name} path crosses a forbidden turn`);
      }
    }
    ok ? pass++ : fail++;
    tick(label, ++done, qs.length, t0, performance.now() - tq0);
  }
}

const trafficQueries = runQueries.filter(q => q.tag === 'pair').slice(0, 100);
console.log(`\nRunning ${runQueries.length} queries × free-flow + ${trafficQueries.length} × traffic-on…`);
runSet('free-flow', runQueries, false);
runSet('traffic-on', trafficQueries, true);

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f}`);
if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
if (fail > 0) process.exitCode = 1;
else console.log('All routers agree with the exact edge-based reference, and every path respects turn restrictions.');
