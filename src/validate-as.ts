import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildGraph } from './build-graph.ts';
import { buildCSR } from './lib/csr.ts';
import { astar as astarTS, nearestNode } from './lib/astar.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  getNodesVisited(): number;
  astar(startIdx: number, endIdx: number): number;
};

const POINTS = [
  { name: 'Monas',             lat: -6.1754, lon: 106.8272 },
  { name: 'Manggarai Station', lat: -6.2108, lon: 106.8500 },
];

const { adj, nodes } = await buildGraph();
console.log('\nBuilding CSR...');
const csr = buildCSR(adj, nodes);
console.log(`  ${csr.n.toLocaleString()} nodes, ${csr.targets.length.toLocaleString()} edges`);

const [start, end] = POINTS;
const startIdx = nearestNode(csr, start!.lat, start!.lon);
const endIdx   = nearestNode(csr, end!.lat,   end!.lon);
console.log(`\nStart: ${start!.name} → index ${startIdx}`);
console.log(`End:   ${end!.name} → index ${endIdx}`);

// --- TypeScript A* ---
console.log('\n[TS A*]');
const t0 = performance.now();
const tsResult = astarTS(csr, startIdx, endIdx);
const tsTime = performance.now() - t0;
if (!tsResult) { console.error('TS: no path found'); process.exit(1); }
console.log(`  Time:          ${tsTime.toFixed(2)} ms`);
console.log(`  Distance:      ${(tsResult.distMeters / 1000).toFixed(3)} km`);
console.log(`  Path nodes:    ${tsResult.path.length}`);
console.log(`  Nodes visited: ${tsResult.nodesVisited.toLocaleString()}`);

// --- AssemblyScript A* ---
console.log('\n[AS A*]');
const wasmBuf = await readFile(path.join(__dirname, '../build/release.wasm'));
// AssemblyScript's NativeMath compiles to imports from the `Math` namespace;
// the DOM `Imports` type doesn't model it, hence the cast.
const importObject = {
  env: {
    abort(_msg: number, _file: number, line: number, col: number): never {
      throw new Error(`AS abort at ${line}:${col}`);
    },
  },
  Math,
} as unknown as WebAssembly.Imports;
const { instance } = await WebAssembly.instantiate(wasmBuf, importObject);
const wasm = instance.exports as unknown as WasmExports;

wasm.initGraph(csr.n, csr.targets.length);

// All heap.alloc calls happen inside initGraph; get buffer after that so it's stable.
const buf = wasm.memory.buffer;
new Int32Array(buf, wasm.getOffsetsPtr(), csr.n + 1).set(csr.offsets);
new Int32Array(buf, wasm.getTargetsPtr(), csr.targets.length).set(csr.targets);
new Float64Array(buf, wasm.getDistPtr(), csr.targets.length).set(csr.distances);
new Float64Array(buf, wasm.getLatsPtr(), csr.n).set(csr.lats);
new Float64Array(buf, wasm.getLonsPtr(), csr.n).set(csr.lons);

const t1 = performance.now();
const rc = wasm.astar(startIdx, endIdx);
const asTime = performance.now() - t1;

if (rc !== 0) { console.error('AS: no path found'); process.exit(1); }

const asLen     = wasm.getPathLen();
const asDist    = wasm.getDistMeters();
const asVisited = wasm.getNodesVisited();
console.log(`  Time:          ${asTime.toFixed(2)} ms`);
console.log(`  Distance:      ${(asDist / 1000).toFixed(3)} km`);
console.log(`  Path nodes:    ${asLen}`);
console.log(`  Nodes visited: ${asVisited.toLocaleString()}`);

// --- Parity ---
console.log('\n[Parity]');
const distMatch = Math.abs(asDist - tsResult.distMeters) < 0.01;
const lenMatch  = asLen === tsResult.path.length;
const visMatch  = asVisited === tsResult.nodesVisited;
console.log(`  Distance:      ${distMatch ? 'PASS' : 'FAIL'} (TS=${tsResult.distMeters.toFixed(2)}, AS=${asDist.toFixed(2)})`);
console.log(`  Path length:   ${lenMatch  ? 'PASS' : 'FAIL'} (TS=${tsResult.path.length}, AS=${asLen})`);
console.log(`  Nodes visited: ${visMatch  ? 'PASS' : 'FAIL'} (TS=${tsResult.nodesVisited}, AS=${asVisited})`);

if (distMatch && lenMatch && visMatch) {
  console.log('\n  AS output matches TS output exactly — step 11 exit criteria MET');
} else {
  console.log('\n  MISMATCH — check graph bug or AS port');
  process.exit(1);
}
