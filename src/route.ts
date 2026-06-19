import { buildGraph } from './build-graph.ts';
import { buildCSR } from './lib/csr.ts';
import { astar, nearestNode } from './lib/astar.ts';

// Hardcoded Jakarta waypoints for validation
const POINTS = [
  { name: 'Monas',              lat: -6.1754, lon: 106.8272 },
  { name: 'Manggarai Station',  lat: -6.2108, lon: 106.8500 },
];

async function osrmDistance(lat1: number, lon1: number, lat2: number, lon2: number): Promise<number | null> {
  const url = `http://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
  try {
    const res = await fetch(url);
    const json = await res.json() as { routes?: Array<{ distance: number }> };
    return json.routes?.[0]?.distance ?? null;
  } catch {
    return null;
  }
}

const { adj, nodes } = await buildGraph();

console.log('\nBuilding CSR...');
const t0 = performance.now();
const csr = buildCSR(adj, nodes);
console.log(`  Done in ${(performance.now() - t0).toFixed(1)} ms`);
console.log(`  ${csr.n.toLocaleString()} nodes, ${csr.targets.length.toLocaleString()} edges`);

const [start, end] = POINTS;

const startIdx = nearestNode(csr, start!.lat, start!.lon);
const endIdx   = nearestNode(csr, end!.lat,   end!.lon);

console.log(`\nStart: ${start!.name} → node ${csr.nodeIds[startIdx]} (${csr.lats[startIdx]?.toFixed(5)}, ${csr.lons[startIdx]?.toFixed(5)})`);
console.log(`End:   ${end!.name}  → node ${csr.nodeIds[endIdx]}  (${csr.lats[endIdx]?.toFixed(5)}, ${csr.lons[endIdx]?.toFixed(5)})`);

console.log('\nRunning A*...');
const t1 = performance.now();
const result = astar(csr, startIdx, endIdx);
const elapsed = performance.now() - t1;

if (!result) {
  console.log('No path found!');
} else {
  const km = (result.distMeters / 1000).toFixed(3);
  console.log(`\nA* result:`);
  console.log(`  Distance:      ${km} km`);
  console.log(`  Path nodes:    ${result.path.length}`);
  console.log(`  Nodes visited: ${result.nodesVisited.toLocaleString()}`);
  console.log(`  Query time:    ${elapsed.toFixed(2)} ms`);

  console.log('\nFetching OSRM reference...');
  const osrmDist = await osrmDistance(start!.lat, start!.lon, end!.lat, end!.lon);
  if (osrmDist === null) {
    console.log('  OSRM unavailable (offline or rate-limited)');
  } else {
    const osrmKm = (osrmDist / 1000).toFixed(3);
    const diffPct = (((result.distMeters - osrmDist) / osrmDist) * 100).toFixed(1);
    console.log(`  OSRM distance: ${osrmKm} km`);
    console.log(`  Difference:    ${diffPct}%`);
    const ok = Math.abs(result.distMeters - osrmDist) / osrmDist < 0.20;
    console.log(`  Validation:    ${ok ? 'PASS (within 20%)' : 'FAIL (>20% off — graph bug?)'}`);
  }
}
