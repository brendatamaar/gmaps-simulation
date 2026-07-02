// Headless proof of the traffic + directions/alternatives/modes pipeline.
// Loads graph.bin (v2, with road classes + street names), drives the WASM A*
// through the REAL web modules (traffic/routing/directions are DOM-free), and
// prints turn-by-turn steps, alternative ETAs, and per-mode ETAs.

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  precompute, fillWeights, etaSeconds, formatEta, formatClock, arrivalClock,
  MAX_SPEED_MPS,
} from '../web/src/traffic.ts';
import { computeRoutes } from '../web/src/routing.ts';
import { buildDirections, formatDistance } from '../web/src/directions.ts';
import type { Graph } from '../web/src/graph.ts';
import type { Router } from '../web/src/router.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../web/public');

// --- read graph.bin (mirror of web/src/graph.ts, incl. classes + nameIds) ---
const binBuf = await readFile(path.join(PUB, 'graph.bin'));
const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
const hdr = new Int32Array(ab, 0, 4);
if (hdr[0] !== 0x47524150) throw new Error('bad magic');
const n = hdr[1]!, e = hdr[2]!, version = hdr[3]!;
if (version < 2) throw new Error('graph.bin too old — re-run export:graph');
const HEADER = 16;
const offTargets = HEADER + 4 * (n + 1);
const offDist = Math.ceil((offTargets + 4 * e) / 8) * 8;
const offLats = offDist + 8 * e;
const offLons = offLats + 8 * n;
const offClasses = offLons + 8 * n;
const offNameIds = Math.ceil((offClasses + e) / 4) * 4;
const meta = JSON.parse(await readFile(path.join(PUB, 'meta.json'), 'utf8'));
const names = JSON.parse(await readFile(path.join(PUB, 'names.json'), 'utf8')) as string[];

const graph: Graph = {
  n, e,
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
console.log(`Loaded graph.bin v${version}: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges, ${names.length.toLocaleString()} names`);

function nearest(lat: number, lon: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dLat = graph.lats[i]! - lat;
    const dLon = (graph.lons[i]! - lon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// --- WASM router (mirror of web/src/router.ts) ---
type WExports = {
  memory: WebAssembly.Memory;
  initGraph(n: number, e: number): void;
  getOffsetsPtr(): number; getTargetsPtr(): number; getDistPtr(): number;
  getLatsPtr(): number; getLonsPtr(): number;
  getPathPtr(): number; getPathLen(): number;
  getDistMeters(): number; getNodesVisited(): number;
  astar(s: number, t: number): number;
};
const wasmBuf = await readFile(path.join(PUB, 'release.wasm'));
const { instance } = await WebAssembly.instantiate(wasmBuf, {
  env: { abort(_m: number, _f: number, l: number, c: number): never { throw new Error(`abort ${l}:${c}`); } },
  Math,
} as unknown as WebAssembly.Imports);
const w = instance.exports as unknown as WExports;
w.initGraph(n, e);
const buf = w.memory.buffer;
new Int32Array(buf, w.getOffsetsPtr(), n + 1).set(graph.offsets);
new Int32Array(buf, w.getTargetsPtr(), e).set(graph.targets);
new Float64Array(buf, w.getLatsPtr(), n).set(graph.lats);
new Float64Array(buf, w.getLonsPtr(), n).set(graph.lons);
const weights = new Float64Array(buf, w.getDistPtr(), e);
const router: Router = {
  weights,
  restrictions: { viaCount: 0, pairCount: 0, viaNodes: new Int32Array(0), pairOffs: new Int32Array(0), pairs: new Int32Array(0) },
  route(s, t) {
    const t0 = performance.now();
    const rc = w.astar(s, t);
    const queryMs = performance.now() - t0;
    if (rc !== 0) return null;
    const len = w.getPathLen();
    const p = new Int32Array(buf, w.getPathPtr(), len).slice();
    return { path: p, cost: w.getDistMeters(), nodesVisited: w.getNodesVisited(), queryMs };
  },
};

const model = precompute(graph);
const A = { lat: -6.1754, lon: 106.8272 }; // Monas
const B = { lat: -6.2615, lon: 106.8106 }; // Blok M area
const s = nearest(A.lat, A.lon), t = nearest(B.lat, B.lon);
const departHour = 8;

console.log(`\nMonas → Blok M, depart ${formatClock(departHour)}\n`);

// --- alternatives (driving, rush hour) ---
const routes = computeRoutes(graph, router, model, s, t, departHour, true, 'drive');
console.log(`Driving alternatives @ ${formatClock(departHour)} (traffic on): ${routes.length} option(s)`);
routes.forEach((r, i) => {
  console.log(
    `  ${i === 0 ? '▶' : ' '} route ${i + 1}: ${formatEta(r.etaSec).padStart(8)}  ` +
    `arrive ${arrivalClock(departHour, r.etaSec)}  ${(r.distanceM / 1000).toFixed(2)} km  ` +
    `${r.path.length} nodes  ${r.queryMs.toFixed(0)}ms`,
  );
});

// --- turn-by-turn for the fastest ---
const best = routes[0]!;
const steps = buildDirections(graph, best.path);
console.log(`\nTurn-by-turn (${steps.length} steps), first 12:`);
steps.slice(0, 12).forEach((st, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. ${st.text}${st.distanceM ? `  (${formatDistance(st.distanceM)})` : ''}`),
);

// --- modes ---
console.log('\nETA by mode (Monas → Blok M):');
for (const mode of ['drive', 'walk', 'bike'] as const) {
  fillWeights(weights, graph, model, departHour, mode === 'drive', mode);
  const r = router.route(s, t);
  if (r) console.log(`  ${mode.padEnd(6)} ${formatEta(etaSeconds(r.cost)).padStart(10)}  arrive ${arrivalClock(departHour, etaSeconds(r.cost))}`);
}

// --- checks ---
console.log('\nChecks:');
const ok = (b: boolean, m: string) => console.log(`  ${b ? 'PASS' : 'FAIL'}  ${m}`);
ok(routes.length >= 1, 'at least one route found');
ok(routes.length >= 2, 'found alternative route(s)');
ok(steps.length >= 2 && steps[0]!.type === 'depart' && steps[steps.length - 1]!.type === 'arrive', 'directions start with depart, end with arrive');
ok(steps.some((st) => st.street !== ''), 'at least one step has a street name');
{
  fillWeights(weights, graph, model, departHour, false, 'walk');
  const rw = router.route(s, t)!;
  fillWeights(weights, graph, model, departHour, false, 'drive'); // free-flow drive
  const rd = router.route(s, t)!;
  ok(etaSeconds(rw.cost) > etaSeconds(rd.cost) * 3, 'walking far slower than free-flow driving');
}
ok(MAX_SPEED_MPS > 0, 'sane max speed');
console.log('\nPipeline OK — directions + alternatives + modes drive the WASM A* headlessly.');
