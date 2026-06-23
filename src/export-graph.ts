import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildGraph } from './build-graph.ts';
import { buildCSR } from './lib/csr.ts';

// Serializes the CSR graph to a compact little-endian binary the browser can
// fetch and feed straight into WASM linear memory. The 892 MB PBF stays on the
// Node side; the browser never parses OSM.
//
// Layout (all little-endian, sections that hold f64 are 8-byte aligned):
//   [0]   magic   i32  = 0x47524150 ("GRAP")
//   [4]   n       i32
//   [8]   e       i32
//   [12]  version i32  = 2 (>=1 ⇒ `classes`; >=2 ⇒ `nameIds` + names.json)
//   offsets   i32 * (n+1)
//   targets   i32 * e
//   <pad to 8>
//   distances f64 * e
//   lats      f64 * n
//   lons      f64 * n
//   classes   u8  * e   (road class per edge, drives time/traffic weights)
//   <pad to 4>
//   nameIds   u32 * e   (street-name id per edge; names.json is the dictionary)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '../web/public');
const WASM_SRC = path.join(__dirname, '../build/release.wasm');

const { adj, nodes, places } = await buildGraph();

console.log('\nBuilding CSR...');
const csr = buildCSR(adj, nodes);
const { n, offsets, targets, distances, classes, nameIds, names, lats, lons } = csr;
const e = targets.length;
console.log(`  ${n.toLocaleString()} nodes, ${e.toLocaleString()} edges`);

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
const total = offNameIds + 4 * e;

const ab = new ArrayBuffer(total);
const hdr = new Int32Array(ab, 0, 4);
hdr[0] = 0x47524150;
hdr[1] = n;
hdr[2] = e;
hdr[3] = 2; // format version: classes + nameIds present
new Int32Array(ab, HEADER, n + 1).set(offsets);
new Int32Array(ab, offTargets, e).set(targets);
new Float64Array(ab, offDist, e).set(distances);
new Float64Array(ab, offLats, n).set(lats);
new Float64Array(ab, offLons, n).set(lons);
new Uint8Array(ab, offClasses, e).set(classes);
new Uint32Array(ab, offNameIds, e).set(nameIds);

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
fs.writeFileSync(path.join(OUT_DIR, 'names.json'), JSON.stringify(names));
fs.writeFileSync(path.join(OUT_DIR, 'places.json'), JSON.stringify(placesOut));
fs.writeFileSync(
  path.join(OUT_DIR, 'meta.json'),
  JSON.stringify({ n, e, bounds: { minLat, maxLat, minLng, maxLng } }, null, 2),
);
fs.copyFileSync(WASM_SRC, path.join(OUT_DIR, 'release.wasm'));

console.log(`\nExported → ${OUT_DIR}`);
console.log(`  graph.bin    ${(total / 1e6).toFixed(1)} MB`);
console.log(`  names.json   ${names.length.toLocaleString()} unique street names`);
console.log(`  places.json  ${placesOut.length.toLocaleString()} places (${Object.entries(placeCounts).map(([k, v]) => `${k}:${v}`).join(', ')})`);
console.log(`  bounds       lat [${minLat.toFixed(4)}, ${maxLat.toFixed(4)}]  lng [${minLng.toFixed(4)}, ${maxLng.toFixed(4)}]`);
console.log(`  release.wasm copied`);
