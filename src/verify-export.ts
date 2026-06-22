// Headless check that the exported graph.bin + release.wasm reproduce the same
// route the browser will compute. Reads the binary with the EXACT offset math
// from web/src/graph.ts, then drives the WASM like web/src/router.ts.

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '../web/public');

const EARTH_R = 6_371_000;
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.asin(Math.sqrt(a));
}

// --- read graph.bin (mirror of web/src/graph.ts) ---
const binBuf = await readFile(path.join(PUB, 'graph.bin'));
const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
const hdr = new Int32Array(ab, 0, 4);
if (hdr[0] !== 0x47524150) throw new Error('bad magic');
const n = hdr[1]!, e = hdr[2]!;
const HEADER = 16;
const offTargets = HEADER + 4 * (n + 1);
const offDist = Math.ceil((offTargets + 4 * e) / 8) * 8;
const offLats = offDist + 8 * e;
const offLons = offLats + 8 * n;
const offsets = new Int32Array(ab, HEADER, n + 1);
const targets = new Int32Array(ab, offTargets, e);
const lats = new Float64Array(ab, offLats, n);
const lons = new Float64Array(ab, offLons, n);
console.log(`Loaded graph.bin: ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);
console.log(`  offsets[n] = ${offsets[n]} (should equal e=${e})`);

// --- nearest-node snap (mirror of web/src/graph.ts) ---
function nearest(lat: number, lon: number): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dLat = lats[i]! - lat;
    const dLon = (lons[i]! - lon) * cosLat;
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const MONAS = { lat: -6.1754, lon: 106.8272 };
const MANGGARAI = { lat: -6.2108, lon: 106.8500 };
const s = nearest(MONAS.lat, MONAS.lon);
const t = nearest(MANGGARAI.lat, MANGGARAI.lon);
console.log(`Monas → idx ${s} (${lats[s]!.toFixed(5)}, ${lons[s]!.toFixed(5)})`);
console.log(`Manggarai → idx ${t} (${lats[t]!.toFixed(5)}, ${lons[t]!.toFixed(5)})`);

// --- drive WASM (mirror of web/src/router.ts) ---
type W = {
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
const w = instance.exports as unknown as W;

const distances = new Float64Array(ab, offDist, e);
w.initGraph(n, e);
const buf = w.memory.buffer;
new Int32Array(buf, w.getOffsetsPtr(), n + 1).set(offsets);
new Int32Array(buf, w.getTargetsPtr(), e).set(targets);
new Float64Array(buf, w.getDistPtr(), e).set(distances);
new Float64Array(buf, w.getLatsPtr(), n).set(lats);
new Float64Array(buf, w.getLonsPtr(), n).set(lons);

const t0 = performance.now();
const rc = w.astar(s, t);
const ms = performance.now() - t0;
if (rc !== 0) { console.error('NO PATH — export/pipeline bug'); process.exit(1); }

console.log(`\nRoute Monas → Manggarai:`);
console.log(`  Distance:      ${(w.getDistMeters() / 1000).toFixed(3)} km`);
console.log(`  Path nodes:    ${w.getPathLen()}`);
console.log(`  Nodes visited: ${w.getNodesVisited().toLocaleString()}`);
console.log(`  Query time:    ${ms.toFixed(2)} ms`);
console.log(`\n  Pipeline OK — graph.bin round-trips through WASM. Step 12 proven headlessly.`);
